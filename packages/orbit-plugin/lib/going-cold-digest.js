/**
 * Going-Cold Digest — weekly Monday 08:00 local time.
 * Queries Orbit for warm contacts that haven't been interacted with in 14+
 * days, composes a digest via the local agent, and delivers it.
 *
 * Schedules itself on a rough cron — checks every 30 min, fires when it's
 * Monday between 08:00 and 08:30 local and hasn't fired today yet.
 */

import { execFileSync } from "node:child_process";

const CHECK_INTERVAL_MS = 30 * 60 * 1000;

const DIGEST_PROMPT = `You are composing a Monday-morning going-cold digest for the user.

Given a JSON array of contacts (each with name, category, score, last interaction, and recent context), write a digest that is:

- Opens with one short framing line
- Lists each contact on its own line: name, days since contact, one-line suggested check-in
- At most 5 contacts
- Warm and direct, not corporate

Return only the digest text. No headers, no preamble.`;

function isMondayMorning(now = new Date()) {
  const dow = now.getDay(); // 0=Sunday, 1=Monday
  if (dow !== 1) return false;
  const hour = now.getHours();
  const min = now.getMinutes();
  return hour === 8 && min < 30;
}

function todayKey(now = new Date()) {
  return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
}

export class GoingColdDigest {
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
    this._lastFiredDay = null;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), CHECK_INTERVAL_MS);
    this._timer.unref?.();
    this._tick();
    this._log.info?.("[going-cold-digest] started (checks every 30min, fires Monday 8am)");
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async _tick() {
    const now = new Date();
    if (!isMondayMorning(now)) return;
    const today = todayKey(now);
    if (this._lastFiredDay === today) return;

    try {
      const briefs = await this.orbit.get("/briefs", { limit: 5, days: 14 });
      const contacts = briefs?.persons || briefs?.contacts || briefs || [];
      if (!Array.isArray(contacts) || contacts.length === 0) {
        this._log.info?.("[going-cold-digest] no going-cold contacts this week");
        this._lastFiredDay = today;
        return;
      }

      const digest = await this._compose(contacts);
      if (digest) {
        await this._send(digest);
        this._lastFiredDay = today;
      }
    } catch (err) {
      this._log.warn?.(`[going-cold-digest] tick error: ${err.message}`);
    }
  }

  async _compose(contacts) {
    try {
      const res = await fetch(`${this.gatewayUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.gatewayToken ? { Authorization: `Bearer ${this.gatewayToken}` } : {}),
        },
        body: JSON.stringify({
          model: "Sonnet",
          messages: [
            { role: "system", content: DIGEST_PROMPT },
            { role: "user", content: JSON.stringify(contacts, null, 2) },
          ],
          temperature: 0.3,
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return (data.choices?.[0]?.message?.content || "").trim();
    } catch (err) {
      this._log.warn?.(`[going-cold-digest] compose failed: ${err.message}`);
      return null;
    }
  }

  async _send(digest) {
    if (!this.deliverTo) {
      this._log.info?.(`[going-cold-digest] ${digest}`);
      return;
    }
    try {
      execFileSync(
        "openclaw",
        [
          "agent",
          "--message", digest,
          "--to", this.deliverTo,
          "--channel", this.deliverChannel,
          "--deliver",
        ],
        { encoding: "utf8", timeout: 30000 }
      );
      this._log.info?.(`[going-cold-digest] delivered to ${this.deliverChannel}:${this.deliverTo}`);
    } catch (err) {
      this._log.warn?.(`[going-cold-digest] send failed: ${err.message}`);
    }
  }
}
