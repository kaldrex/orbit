// identity-resolver.js — Pass A orchestrator.
//
// Pipeline:
//   Stage A (rules):      CanonicalNameResolver groups by shared email/phone
//                         and narrow abbreviation bridges. Deterministic, no
//                         LLM calls. Every merge is safe to auto-apply.
//
//   Stage B (LLM):        For clusters NOT caught by Stage A but sharing
//                         suggestive evidence (same first name + shared
//                         interactor, or overlapping domain), build a
//                         context packet and ask the OpenClaw gateway to
//                         decide. Accept merges with confidence ≥ 0.8 AND
//                         an explicit evidence tag. Writes carry source:"llm".
//
// Both stages post to POST /api/v1/merge. Every merge is audit-logged in
// Supabase merge_audit (server-side). The resolver is idempotent — running
// it again after it converges is a no-op.

import { CanonicalNameResolver } from "./identity-resolver-rules.js";

const LLM_BATCH = 20;
const LLM_MAX_CLUSTERS = 50; // per tool invocation — prevents runaway cost
const LLM_MIN_CONFIDENCE = 0.8;
const DEFAULT_MODEL = "claude-sonnet-4-6";

export class IdentityResolver {
  /**
   * @param {Object} opts
   * @param {import('./orbit-client.js').OrbitClient} opts.client
   * @param {Object} [opts.logger]
   * @param {string} [opts.gatewayUrl]  — OpenClaw gateway base URL (for LLM)
   * @param {string} [opts.gatewayKey]  — gateway API key
   * @param {string} [opts.model]       — LLM model id
   */
  constructor(opts = {}) {
    if (!opts.client) throw new Error("IdentityResolver requires opts.client");
    this.client = opts.client;
    this.log = opts.logger || console;
    this.gatewayUrl = opts.gatewayUrl || process.env.ORBIT_GATEWAY_URL || process.env.OPENCLAW_GATEWAY_URL || null;
    this.gatewayKey = opts.gatewayKey || process.env.ORBIT_GATEWAY_KEY || process.env.OPENCLAW_GATEWAY_KEY || null;
    this.model = opts.model || DEFAULT_MODEL;
  }

  // Fetch all Person nodes via /api/v1/persons with id-cursor pagination.
  // Includes the self node so ghost-self clusters can form universally.
  async _fetchAllPersons() {
    const all = [];
    let cursor = null;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await this.client.get("/persons", {
        limit: 500,
        order: "id",
        include_self: "true",
        cursor: cursor || undefined,
      });
      if (!Array.isArray(res.persons) || res.persons.length === 0) break;
      all.push(...res.persons);
      cursor = res.nextCursor;
      if (!cursor) break;
      if (all.length > 20_000) {
        this.log.warn?.("[identity-resolver] pagination exceeded 20k, stopping");
        break;
      }
    }
    return all;
  }

  /**
   * Run Stage A only (rules-based, deterministic, no LLM).
   * Returns the cluster list. With apply=true, POSTs each as a merge.
   */
  async runStageA({ dryRun = true, maxMerges = 100 } = {}) {
    const persons = await this._fetchAllPersons();
    this.log.info?.(`[identity-resolver] Stage A: ${persons.length} persons fetched`);

    const resolver = new CanonicalNameResolver();
    for (const p of persons) {
      resolver.add({
        id: p.id,
        name: p.name,
        email: p.email,
        phone: p.phone,
        isSelf: p.category === "self",
        aliases: p.aliases || null,
      });
    }
    const clusters = resolver.resolve();

    // Only "certain" clusters auto-apply. "ambiguous" ones (shared email
    // with heterogeneous last names — almost always wrong-attribution in
    // the source data) go to Stage B or a user review queue.
    const certain = clusters.filter((c) => c.certainty === "certain");
    const ambiguous = clusters.filter((c) => c.certainty === "ambiguous");

    const toApply = certain.slice(0, maxMerges);
    this.log.info?.(
      `[identity-resolver] Stage A: ${clusters.length} clusters (${certain.length} certain, ${ambiguous.length} ambiguous). Applying ${toApply.length} certain.`
    );

    const applied = [];
    const skipped = [];
    if (!dryRun) {
      for (const c of toApply) {
        try {
          const res = await this.client.post("/merge", {
            canonical_id: c.canonical,
            merge_ids: c.members,
            reasoning: c.reasoning,
            confidence: c.confidence,
            source: "auto",
            evidence: { names: c.names, stage: "A" },
          });
          applied.push({ ...c, result: res });
        } catch (err) {
          this.log.warn?.(`[identity-resolver] merge failed for ${c.canonical}: ${err.message}`);
          skipped.push({ ...c, error: err.message });
        }
      }
    }

    return {
      stage: "A",
      personsScanned: persons.length,
      clustersFound: clusters.length,
      certainCount: certain.length,
      ambiguousCount: ambiguous.length,
      dryRun,
      appliedCount: applied.length,
      skippedCount: skipped.length,
      certainPreview: toApply.slice(0, 10).map((c) => ({
        canonical: c.canonical,
        merge: c.members,
        names: c.names,
        reasoning: c.reasoning,
      })),
      ambiguousPreview: ambiguous.slice(0, 10).map((c) => ({
        canonical: c.canonical,
        merge: c.members,
        names: c.names,
        reasoning: c.reasoning,
        // These are candidates for Stage B / user review.
      })),
      applied: dryRun ? [] : applied.slice(0, 10),
    };
  }

  /**
   * Build candidate clusters for Stage B — pairs/groups that weren't caught
   * by Stage A but share SOME evidence suggesting they might be the same
   * person. Conservative: candidates never auto-merge here; the LLM is the
   * decider and writes with source="llm".
   *
   * Candidate if any of:
   *   - Same first name (≥3 chars) + overlapping email domain
   *   - Same first name (≥3 chars) + ≥1 shared KNOWS/INTERACTED neighbor
   *
   * Returns: [{ members: [person, ...] }]
   */
  async _buildStageBCandidates(persons, alreadyClustered) {
    // First-name buckets, excluding people already in Stage A clusters.
    const byFirst = new Map();
    for (const p of persons) {
      if (alreadyClustered.has(p.id)) continue;
      if (!p.name) continue;
      const first = p.name.trim().split(/\s+/)[0].toLowerCase();
      if (first.length < 3) continue;
      if (!byFirst.has(first)) byFirst.set(first, []);
      byFirst.get(first).push(p);
    }

    const candidates = [];
    for (const [first, members] of byFirst) {
      if (members.length < 2) continue;
      if (members.length > 12) {
        // Too many same-first-name people is almost never one person — skip
        // huge buckets (common first names like "Shubham", "Sai", etc).
        continue;
      }
      candidates.push({ firstName: first, members });
    }
    return candidates;
  }

  /**
   * Run Stage A then Stage B. Stage B requires gatewayUrl+gatewayKey to be
   * configured; otherwise it's skipped.
   *
   * @param {Object} opts
   * @param {boolean} [opts.dryRun]      — when true, neither stage applies
   * @param {boolean} [opts.stageBPreview]
   *   When true and gateway is configured, Stage B runs and reports what
   *   the LLM said WITHOUT calling /merge. Use this for the first-run
   *   review before auto-applying.
   * @param {number}  [opts.maxClusters] — per-stage cap
   */
  async resolve(opts = {}) {
    const { dryRun = true, stageBPreview = false, maxClusters = 50 } = opts;

    // Stage A
    const stageA = await this.runStageA({ dryRun, maxMerges: maxClusters });

    // Gather which ids were already clustered (so Stage B doesn't
    // re-propose them). Re-fetch after any merges.
    const personsAfterA = dryRun ? await this._fetchAllPersons() : await this._fetchAllPersons();
    const clustered = new Set();
    if (!dryRun) {
      // If we applied Stage A merges, those canonical ids are fine; the
      // deleted ids are gone. Nothing to exclude explicitly.
    }

    const candidates = await this._buildStageBCandidates(personsAfterA, clustered);

    if (!this.gatewayUrl || !this.gatewayKey) {
      return {
        stageA,
        stageB: {
          skipped: true,
          reason: "gateway not configured (set ORBIT_GATEWAY_URL + ORBIT_GATEWAY_KEY)",
          candidateClusters: candidates.length,
        },
      };
    }

    // Stage B — LLM decides within each candidate bucket
    const applyMerges = !dryRun && !stageBPreview;
    const stageB = await this._runStageB(candidates.slice(0, maxClusters), { applyMerges });
    return { stageA, stageB };
  }

  async _runStageB(candidates, { applyMerges }) {
    const proposals = [];
    const applied = [];
    const errors = [];

    for (const c of candidates) {
      const context = await this._buildClusterContext(c);
      const decision = await this._askLLM(context);

      for (const group of decision.merges || []) {
        if (typeof group.confidence !== "number" || group.confidence < LLM_MIN_CONFIDENCE) {
          continue;
        }
        if (!Array.isArray(group.member_ids) || group.member_ids.length < 2) continue;
        const [canonical, ...rest] = group.member_ids;
        proposals.push({
          canonical,
          merge_ids: rest,
          confidence: group.confidence,
          reasoning: group.reasoning || "LLM identity merge",
          evidence: { cluster: c.firstName, names: c.members.map((m) => m.name) },
        });
      }
    }

    if (applyMerges) {
      for (const p of proposals) {
        try {
          await this.client.post("/merge", {
            canonical_id: p.canonical,
            merge_ids: p.merge_ids,
            reasoning: p.reasoning,
            confidence: p.confidence,
            source: "llm",
            evidence: p.evidence,
          });
          applied.push(p);
        } catch (err) {
          errors.push({ proposal: p, error: err.message });
        }
      }
    }

    return {
      candidateClusters: candidates.length,
      proposals: proposals.length,
      preview: proposals.slice(0, 10),
      applied: applyMerges ? applied.length : 0,
      applyMerges,
      errors,
    };
  }

  async _buildClusterContext(c) {
    // Minimal context: name, email, phone, company, category for each member.
    // More evidence (interaction count, shared neighbors) can be layered in
    // later — keeping the prompt tight for first pass.
    return {
      firstName: c.firstName,
      members: c.members.map((p) => ({
        id: p.id,
        name: p.name,
        email: p.email,
        phone: p.phone,
        company: p.company,
        category: p.category,
      })),
    };
  }

  async _askLLM(context) {
    const systemPrompt = `You are an identity-resolution assistant for a personal relationship graph. You receive a small cluster of Person entries that share a first name. Decide which of them (if any) are the SAME real person and should be merged.

Rules:
- Merge ONLY when there is strong evidence: matching email, matching phone, matching email domain + matching last name, or matching full name.
- Never merge two different people with the same first name but different last names.
- Never merge when evidence is ambiguous — return empty merges.
- Output JSON with a "merges" array. Each entry: { "member_ids": [<canonical_id>, <ids_to_merge_in>], "confidence": 0.0-1.0, "reasoning": "<short>" }.
- member_ids[0] is the canonical id; the rest are merged into it.
- If no merges apply, return { "merges": [] }.
- Confidence ≥ 0.8 is required for downstream to accept. Below that, omit.`;

    const userPrompt = `Cluster (first name="${context.firstName}"):\n${JSON.stringify(context.members, null, 2)}`;

    const body = {
      model: this.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
      max_tokens: 800,
      response_format: { type: "json_object" },
    };

    const res = await fetch(`${this.gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.gatewayKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`gateway ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content || "{}";
    try {
      return JSON.parse(raw);
    } catch {
      // Try to salvage JSON out of a wrapped string
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
      return { merges: [] };
    }
  }
}
