import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = JSON.parse(
  readFileSync(path.join(HERE, "..", "data", "domains.json"), "utf8"),
);

const PERSONAL = new Set(CORPUS.personal);
const BOT = new Set(CORPUS.bot);
const SAAS = new Set(CORPUS.saas);
const PRESS = new Set(CORPUS.press);
const BOT_LOCALPART_PATTERNS = (CORPUS.bot_patterns ?? []).map(
  (p) => new RegExp(p, "i"),
);

/**
 * Classify a domain (or optionally an email whose local-part we can
 * additionally scan for bot patterns) into one of:
 *   personal | work | bot | saas | press | other
 *
 * Inputs: domain required, optional localpart_for_bot_check that lets
 * the observer skill pass the full "noreply@example.com" when the
 * domain itself isn't on the bot list but the local-part gives it away.
 */
export function domainClass({ domain, localpart_for_bot_check }) {
  const original = domain ?? "";
  if (!original || typeof original !== "string") {
    return { class: "other", confidence: 0, evidence: "empty or non-string input" };
  }

  const d = original.trim().toLowerCase();
  if (!d) {
    return { class: "other", confidence: 0, evidence: "empty after trim" };
  }

  if (localpart_for_bot_check) {
    const lp = localpart_for_bot_check.toLowerCase();
    for (const re of BOT_LOCALPART_PATTERNS) {
      if (re.test(`${lp}@${d}`) || re.test(`${lp}@`)) {
        return { class: "bot", confidence: 0.85, evidence: `local-part matches ${re.source}` };
      }
    }
  }

  if (BOT.has(d)) {
    return { class: "bot", confidence: 0.95, evidence: "domain in bot list" };
  }
  if (PERSONAL.has(d)) {
    return { class: "personal", confidence: 0.95, evidence: "domain in personal list" };
  }
  if (SAAS.has(d)) {
    return { class: "saas", confidence: 0.9, evidence: "domain in saas list" };
  }
  if (PRESS.has(d)) {
    return { class: "press", confidence: 0.9, evidence: "domain in press list" };
  }

  // heuristic: .press or .news TLD → press
  if (d.endsWith(".press") || d.endsWith(".news")) {
    return { class: "press", confidence: 0.7, evidence: "tld heuristic" };
  }

  // if it's not personal/bot/saas/press and is a plain corporate-style
  // domain (e.g. company.com, startup.ai), call it work. We can't be
  // certain, but it's the most useful default for relationship signal.
  if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(d) && !d.includes("..")) {
    return { class: "work", confidence: 0.6, evidence: "default: corporate-shaped domain" };
  }

  return { class: "other", confidence: 0.3, evidence: "no rule matched" };
}
