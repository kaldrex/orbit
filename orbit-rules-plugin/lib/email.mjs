// RFC 5321 says local-parts are case-sensitive. In practice no major
// provider honors that. Lowercasing everywhere is what every real CRM,
// de-duper, and email client does. We do the same.
//
// Gmail-family (gmail.com, googlemail.com): strip dots from local-part
// and strip "+suffix" labels. For all other domains, keep local-part
// as-is after lowercasing.

const GMAIL_FAMILY = new Set(["gmail.com", "googlemail.com"]);

const EMAIL_RE = /^([^\s@]+)@([a-z0-9][a-z0-9.-]*\.[a-z]{2,})$/i;

export function canonicalizeEmail({ email }) {
  const original = email ?? "";
  if (!original || typeof original !== "string") {
    return { canonical: null, domain: null, valid: false, original: String(original) };
  }

  const lowered = original.trim().toLowerCase();
  const m = lowered.match(EMAIL_RE);
  if (!m) {
    return { canonical: null, domain: null, valid: false, original };
  }

  let [, local, domain] = m;

  // strip "+anything" once — multiple +'s are unusual, but handle them
  const plus = local.indexOf("+");
  if (plus >= 0) local = local.slice(0, plus);

  if (GMAIL_FAMILY.has(domain)) {
    local = local.replace(/\./g, "");
    // normalize googlemail.com → gmail.com so the two alias back to one
    domain = "gmail.com";
  }

  if (!local) {
    return { canonical: null, domain, valid: false, original };
  }

  return {
    canonical: `${local}@${domain}`,
    domain,
    valid: true,
    original,
  };
}
