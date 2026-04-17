/**
 * Pre-Meeting Briefing — checks upcoming calendar events every 5 minutes.
 * For any event starting in the next 20–30 minutes with external attendees,
 * fetches each attendee's person card from Orbit, asks the agent to compose
 * a concise brief, and delivers it via the user's primary channel.
 *
 * This is the flagship founder feature: right before a call, their agent
 * pings them with "what you need to know" about the person they're meeting.
 */

import { execFileSync } from "node:child_process";

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const LOOKAHEAD_MIN = 30;
const DELIVERED_TTL_MS = 6 * 60 * 60 * 1000; // avoid re-sending for 6h

const BRIEF_PROMPT = `You are preparing a pre-meeting brief for the user. A calendar event starts soon with one or more contacts.

Given a JSON payload containing the event and each attendee's Orbit person card (recent interactions, category, company, notes), write a brief that is:

- 3–5 lines, no headers, no bullet markers
- Action-oriented: what to remember, what's open, what's the ask
- Names people and topics specifically
- If attendees have strong mutual connections, mention one
- If a thread is unresolved, flag it

Tone: a trusted chief-of-staff texting you before a call. Terse. Helpful.

Return only the brief text — no preamble, no JSON, no quotes.`;

export class PreMeetingBrief {
  /**
   * @param {Object} opts
   * @param {import('./orbit-client.js').OrbitClient} opts.orbitClient
   * @param {string} [opts.gatewayUrl]
   * @param {string} [opts.gatewayToken]
   * @param {string} [opts.deliverTo]   — phone/slack/telegram target from openclaw config
   * @param {string} [opts.deliverChannel] — whatsapp | slack | telegram
   * @param {Object} [opts.logger]
   */
  constructor(opts) {
    this.orbit = opts.orbitClient;
    this.gatewayUrl =
      opts.gatewayUrl ||
      process.env.OPENCLAW_GATEWAY_URL ||
      "http://127.0.0.1:18789";
    this.gatewayToken =
      opts.gatewayToken || process.env.OPENCLAW_GATEWAY_TOKEN || "";
    this.deliverTo = opts.deliverTo || process.env.ORBIT_DELIVER_TO || "";
    this.deliverChannel =
      opts.deliverChannel || process.env.ORBIT_DELIVER_CHANNEL || "whatsapp";
    this._log = opts.logger || console;
    this._timer = null;
    this._delivered = new Map(); // eventId -> expiresAt
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), CHECK_INTERVAL_MS);
    this._timer.unref?.();
    // Run once immediately so we don't wait a full interval on startup
    this._tick();
    this._log.info?.("[pre-meeting-brief] started (5-min cadence)");
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async _tick() {
    try {
      const now = Date.now();
      // Clean expired delivered entries
      for (const [id, expires] of this._delivered) {
        if (expires < now) this._delivered.delete(id);
      }

      const events = this._fetchUpcomingEvents();
      for (const event of events) {
        if (this._delivered.has(event.id)) continue;

        const attendees = this._extractExternalAttendees(event);
        if (attendees.length === 0) continue;

        await this._deliverBrief(event, attendees);
        this._delivered.set(event.id, now + DELIVERED_TTL_MS);
      }
    } catch (err) {
      this._log.warn?.(`[pre-meeting-brief] tick error: ${err.message}`);
    }
  }

  _fetchUpcomingEvents() {
    const now = new Date();
    const future = new Date(now.getTime() + LOOKAHEAD_MIN * 60 * 1000);

    let raw;
    try {
      raw = execFileSync(
        "gws",
        [
          "calendar", "events", "list",
          "--params",
          JSON.stringify({
            calendarId: "primary",
            singleEvents: true,
            timeMin: now.toISOString(),
            timeMax: future.toISOString(),
            orderBy: "startTime",
            maxResults: 20,
          }),
        ],
        { encoding: "utf8", timeout: 15000, maxBuffer: 10 * 1024 * 1024 }
      );
    } catch (err) {
      this._log.warn?.(`[pre-meeting-brief] gws failed: ${err.message}`);
      return [];
    }

    try {
      const data = JSON.parse(raw);
      return Array.isArray(data.items) ? data.items : [];
    } catch {
      return [];
    }
  }

  _extractExternalAttendees(event) {
    const attendees = event.attendees || [];
    return attendees
      .filter((a) => !a.self && a.email && a.responseStatus !== "declined")
      .map((a) => ({ email: a.email.toLowerCase(), name: a.displayName || "" }));
  }

  async _deliverBrief(event, attendees) {
    // Fetch person cards from Orbit for each attendee (by email lookup)
    const personCards = [];
    for (const att of attendees) {
      try {
        const result = await this.orbit.get("/persons", { q: att.email, limit: 1 });
        const hit = result?.persons?.[0];
        if (hit?.id) {
          const card = await this.orbit.get(`/persons/${hit.id}`);
          personCards.push({ email: att.email, name: att.name, card });
        } else {
          personCards.push({ email: att.email, name: att.name, card: null });
        }
      } catch (err) {
        this._log.warn?.(`[pre-meeting-brief] lookup failed for ${att.email}: ${err.message}`);
        personCards.push({ email: att.email, name: att.name, card: null });
      }
    }

    const brief = await this._composeBrief(event, personCards);
    if (!brief) return;

    await this._send(brief);
  }

  async _composeBrief(event, personCards) {
    const payload = {
      event: {
        title: event.summary || "Untitled event",
        startTime: event.start?.dateTime || event.start?.date,
        location: event.location || null,
      },
      attendees: personCards.map((pc) => ({
        email: pc.email,
        displayName: pc.name,
        orbit: pc.card
          ? {
              category: pc.card.category,
              company: pc.card.company,
              score: pc.card.score,
              lastInteractions: pc.card.interactions?.slice(0, 5) || [],
              sharedConnections: pc.card.sharedConnections?.slice(0, 5) || [],
              relationshipContext: pc.card.relationship_to_me || null,
            }
          : "not in graph yet",
      })),
    };

    try {
      const res = await fetch(`${this.gatewayUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.gatewayToken
            ? { Authorization: `Bearer ${this.gatewayToken}` }
            : {}),
        },
        body: JSON.stringify({
          model: "Sonnet",
          messages: [
            { role: "system", content: BRIEF_PROMPT },
            { role: "user", content: JSON.stringify(payload, null, 2) },
          ],
          temperature: 0.3,
        }),
      });
      if (!res.ok) {
        this._log.warn?.(`[pre-meeting-brief] gateway ${res.status}`);
        return null;
      }
      const data = await res.json();
      return (data.choices?.[0]?.message?.content || "").trim();
    } catch (err) {
      this._log.warn?.(`[pre-meeting-brief] compose failed: ${err.message}`);
      return null;
    }
  }

  async _send(brief) {
    if (!this.deliverTo) {
      this._log.info?.("[pre-meeting-brief] no ORBIT_DELIVER_TO set — logging only");
      this._log.info?.(`[pre-meeting-brief] ${brief}`);
      return;
    }

    try {
      execFileSync(
        "openclaw",
        [
          "agent",
          "--message", brief,
          "--to", this.deliverTo,
          "--channel", this.deliverChannel,
          "--deliver",
        ],
        { encoding: "utf8", timeout: 30000 }
      );
      this._log.info?.(`[pre-meeting-brief] delivered to ${this.deliverChannel}:${this.deliverTo}`);
    } catch (err) {
      this._log.warn?.(`[pre-meeting-brief] send failed: ${err.message}`);
    }
  }
}
