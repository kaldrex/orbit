/**
 * LLM Categorizer — agent-side categorization for ambiguous contacts.
 *
 * Rules handle ~84% of contacts (team by email domain, newsletters by local
 * part, known team members, phone-number junk). The remaining ~16% need
 * judgment — is "Ramon Berrios" an investor, founder, or friend? We ask
 * the user's local OpenClaw agent via its OpenAI-compatible chatCompletions
 * endpoint, so the user's model budget pays, not ours.
 *
 * Contract:
 *   categorize(contact) -> { category, confidence, reasoning }
 *   categorizeBatch(contacts) -> Array<same>
 */

const VALID_CATEGORIES = [
  "team", "investor", "sponsor", "fellow", "media",
  "community", "founder", "friend", "press", "other",
];

const CATEGORIZATION_PROMPT = `You are categorizing contacts in a founder's relationship graph. For each contact, assign ONE category from this list:

- team: works with or for the user (co-founder, employee, contractor)
- investor: VCs, angels, fund managers
- sponsor: companies or people sponsoring events
- fellow: industry peers, conference connections, other builders
- media: journalists, content creators, podcast hosts
- community: community leaders, event organizers, moderators
- founder: other founders, entrepreneurs
- friend: personal friend, non-business
- press: press contacts specifically for coverage
- other: genuinely can't determine — use sparingly

Input is a JSON array of contacts with signals. Output MUST be a JSON array of the same length, same order, with this shape per contact:

{"id": "<input id>", "category": "<one of above>", "confidence": 0.0-1.0, "reasoning": "<one sentence>"}

Be decisive. Use "other" only when signals are genuinely ambiguous. Return ONLY the JSON array, no preamble.`;

/**
 * Build a concise signal summary for one contact, suitable for LLM input.
 */
function buildSignalSummary(contact) {
  const sig = {
    id: contact.id || contact.name,
    name: contact.name,
  };
  if (contact.company) sig.company = contact.company;
  if (contact.email) sig.email = contact.email;
  if (contact.title) sig.title = contact.title;
  if (contact.interactionCount) sig.interactions = contact.interactionCount;
  if (contact.channels?.length) sig.channels = contact.channels;
  if (contact.sampleSummary) sig.sample = contact.sampleSummary.slice(0, 140);
  return sig;
}

export class LlmCategorizer {
  /**
   * @param {Object} opts
   * @param {string} [opts.gatewayUrl]  — defaults to env OPENCLAW_GATEWAY_URL or http://127.0.0.1:18789
   * @param {string} [opts.gatewayToken]— defaults to env OPENCLAW_GATEWAY_TOKEN
   * @param {string} [opts.model]       — model alias to use (passed through)
   * @param {Object} [opts.logger]
   */
  constructor(opts = {}) {
    this.gatewayUrl =
      opts.gatewayUrl ||
      process.env.OPENCLAW_GATEWAY_URL ||
      "http://127.0.0.1:18789";
    this.gatewayToken =
      opts.gatewayToken || process.env.OPENCLAW_GATEWAY_TOKEN || "";
    this.model = opts.model || "Sonnet";
    this._log = opts.logger || console;
  }

  /**
   * Categorize a batch of contacts in a single LLM call.
   * Contacts come as: [{id, name, company?, email?, title?, interactionCount?, channels?, sampleSummary?}]
   * Returns: [{id, category, confidence, reasoning}]
   */
  async categorizeBatch(contacts) {
    if (!contacts.length) return [];
    if (contacts.length > 30) {
      // Split into chunks of 20 to keep prompts reasonable
      const out = [];
      for (let i = 0; i < contacts.length; i += 20) {
        const chunk = await this.categorizeBatch(contacts.slice(i, i + 20));
        out.push(...chunk);
      }
      return out;
    }

    const signals = contacts.map(buildSignalSummary);

    const body = {
      model: this.model,
      messages: [
        { role: "system", content: CATEGORIZATION_PROMPT },
        { role: "user", content: JSON.stringify(signals, null, 2) },
      ],
      temperature: 0,
      response_format: { type: "json_object" },
    };

    let response;
    try {
      response = await fetch(`${this.gatewayUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.gatewayToken
            ? { Authorization: `Bearer ${this.gatewayToken}` }
            : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      this._log.warn?.(`[llm-categorizer] gateway unreachable: ${err.message}`);
      return contacts.map((c) => ({
        id: c.id || c.name,
        category: "other",
        confidence: 0,
        reasoning: "gateway unreachable",
      }));
    }

    if (!response.ok) {
      this._log.warn?.(
        `[llm-categorizer] gateway ${response.status}: falling back to 'other'`
      );
      return contacts.map((c) => ({
        id: c.id || c.name,
        category: "other",
        confidence: 0,
        reasoning: `gateway ${response.status}`,
      }));
    }

    let parsed;
    try {
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || "[]";
      const obj = JSON.parse(content);
      // Accept either a bare array or { contacts: [...] } / { categories: [...] }
      parsed = Array.isArray(obj)
        ? obj
        : obj.contacts || obj.categories || obj.results || [];
    } catch (err) {
      this._log.warn?.(`[llm-categorizer] parse failure: ${err.message}`);
      parsed = [];
    }

    // Normalize: ensure every input contact gets a result, validate category
    const byId = new Map();
    for (const r of parsed) {
      if (r?.id) byId.set(String(r.id), r);
    }

    return contacts.map((c) => {
      const id = c.id || c.name;
      const r = byId.get(String(id));
      const category = VALID_CATEGORIES.includes(r?.category)
        ? r.category
        : "other";
      return {
        id,
        category,
        confidence: Number(r?.confidence ?? 0),
        reasoning: r?.reasoning || "no LLM response",
      };
    });
  }

  /**
   * Categorize a single contact. Wrapper around categorizeBatch.
   */
  async categorize(contact) {
    const [result] = await this.categorizeBatch([contact]);
    return result;
  }
}
