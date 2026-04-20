// Safety drop rules for person-name candidates. Every function here is a
// pure boolean predicate over strings — no I/O. The orchestrator
// `safetyDropReason()` returns the first matching reason code or null.
//
// Reason codes (stable, machine-readable):
//   "phone_as_name"        — the "name" is just a phone number.
//   "unicode_masked_phone" — "+91∙∙∙∙∙∙∙∙46"-class masked phones.
//   "email_as_name"        — the "name" is an email address.
//   "quoted_literal"       — "'Sarmista'" / "\"Amit\"" / "‘Tamas’".
//   "empty_name"           — empty string / whitespace-only.
//   "bot_name"             — "wazowski", "slackbot", etc.
//   "test_data_leak"       — example.com/test.com markers in name/emails/phones.
//
// Precedence order (applied by safetyDropReason):
//   phone > unicode > email > quoted > empty > bot > test_leak.

// Strictly digits (with optional leading +), 6+ chars.
const PHONE_RE = /^\+?\d{6,}$/u;

// Phone-shape but with obfuscation characters: ASCII space, dot, hyphen,
// plus the unicode middle-dot family we see in real DB violations.
// U+2022 • "bullet", U+2219 ∙ "bullet operator", U+00B7 · "middle dot",
// U+30FB ・ "katakana middle dot".
const UNICODE_MASK_RE = /^\+?[\d\s.\-\u2022\u2219\u00B7\u30FB]{6,}$/u;

// Contains an @ with something on both sides → treat as email-as-name.
const EMAIL_RE = /.+@.+/u;

// Starts AND ends with a matching-ish quote character. Covers ASCII ' and ",
// curly ‘ ’ “ ”, and backtick.
const QUOTE_OPEN = `['"\u2018\u201C\u0060]`;
const QUOTE_CLOSE = `['"\u2019\u201D\u0060]`;
const QUOTED_RE = new RegExp(`^${QUOTE_OPEN}.+${QUOTE_CLOSE}$`, "u");

const BOT_NAMES = new Set([
  "wazowski",
  "chad",
  "axe",
  "kite",
  "slackbot",
  "github-actions",
]);

// Test/example data markers. Checked against name + emails[] + phones[].
const TEST_DATA_MARKERS = [
  /example\.com/i,
  /example\.org/i,
  /@test\.com/i,
  /\bapitest\./i,
];

export function isPhoneAsName(name) {
  if (typeof name !== "string") return false;
  return PHONE_RE.test(name.trim());
}

export function isUnicodeMaskedPhone(name) {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  // Must contain at least one MASK character (any of: ASCII space, dot,
  // hyphen, or the unicode middle-dot family) — otherwise it's already
  // caught by isPhoneAsName (pure-digits).
  if (!/[\s.\-\u2022\u2219\u00B7\u30FB]/u.test(trimmed)) return false;
  return UNICODE_MASK_RE.test(trimmed);
}

export function isEmailAsName(name) {
  if (typeof name !== "string") return false;
  return EMAIL_RE.test(name.trim());
}

export function isQuotedLiteralName(name) {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  if (trimmed.length < 2) return false;
  return QUOTED_RE.test(trimmed);
}

export function isEmptyOrWhitespace(name) {
  if (name === null || name === undefined) return true;
  if (typeof name !== "string") return false;
  return name.trim() === "";
}

export function isKnownBotName(name) {
  if (typeof name !== "string") return false;
  return BOT_NAMES.has(name.trim().toLowerCase());
}

export function isTestDataLeak(name, emails = [], phones = []) {
  const candidates = [
    typeof name === "string" ? name : "",
    ...(Array.isArray(emails) ? emails.map((e) => String(e ?? "")) : []),
    ...(Array.isArray(phones) ? phones.map((p) => String(p ?? "")) : []),
  ];
  for (const c of candidates) {
    if (!c) continue;
    for (const re of TEST_DATA_MARKERS) {
      if (re.test(c)) return true;
    }
  }
  return false;
}

/**
 * Run all six drop rules in precedence order. Returns the first matching
 * reason code or null if the candidate passes.
 *
 * @param {{name: string, emails?: string[], phones?: string[]}} candidate
 * @returns {string | null}
 */
export function safetyDropReason(candidate) {
  const name = candidate?.name ?? "";
  const emails = candidate?.emails ?? [];
  const phones = candidate?.phones ?? [];

  if (isEmptyOrWhitespace(name)) return "empty_name";
  if (isPhoneAsName(name)) return "phone_as_name";
  if (isUnicodeMaskedPhone(name)) return "unicode_masked_phone";
  if (isEmailAsName(name)) return "email_as_name";
  if (isQuotedLiteralName(name)) return "quoted_literal";
  if (isKnownBotName(name)) return "bot_name";
  if (isTestDataLeak(name, emails, phones)) return "test_data_leak";
  return null;
}
