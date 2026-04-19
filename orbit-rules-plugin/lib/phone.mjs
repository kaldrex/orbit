import { parsePhoneNumberFromString } from "libphonenumber-js";

/**
 * Canonicalize a phone string to E.164.
 *
 * Inputs can be messy: WhatsApp jids, Google Contacts canonical form,
 * free-text "+971 58 678 3040", "(971) 58 678-3040", etc. We strip the
 * "@s.whatsapp.net" suffix before parsing.
 *
 * defaultCountry gates ambiguous local numbers without a leading "+"
 * or country code. Defaults to IN (India) for V0 — the founder's
 * primary region.
 */
export function normalizePhone({ phone, default_country }) {
  const original = phone ?? "";
  if (!original || typeof original !== "string") {
    return { e164: null, country_code: null, valid: false, original: String(original) };
  }

  // strip WhatsApp jid suffixes if present
  let cleaned = original.trim();
  cleaned = cleaned.replace(/@s\.whatsapp\.net$/i, "");
  cleaned = cleaned.replace(/@lid$/i, "");
  cleaned = cleaned.replace(/@g\.us$/i, "");

  const country = (
    default_country ||
    process.env.ORBIT_RULES_DEFAULT_COUNTRY ||
    "IN"
  ).toUpperCase();

  // If the input is all digits and long enough to plausibly be an
  // international number (11+ digits, WhatsApp jid shape), try parsing
  // it with a leading "+" first. libphonenumber-js can't infer the
  // country from digits alone without a defaultCountry, but the WA jid
  // convention is <countrycode><number> with no "+", so "+" + digits
  // is the right interpretation 99% of the time.
  let parsed = null;
  if (/^\d{11,15}$/.test(cleaned)) {
    parsed = parsePhoneNumberFromString("+" + cleaned);
  }
  if (!parsed || !parsed.isValid()) {
    parsed = parsePhoneNumberFromString(cleaned, country);
  }

  if (!parsed || !parsed.isValid()) {
    return { e164: null, country_code: null, valid: false, original };
  }

  return {
    e164: parsed.number, // already E.164 with "+"
    country_code: parsed.country ?? null,
    valid: true,
    original,
  };
}
