// rules.js — Gmail message filtering rules for Orbit.
//
// Filters out newsletters, promotions, and automated emails so only
// real human conversations become signals.

const NEWSLETTER_DOMAINS = new Set([
  "nvidia.com",
  "google.com",
  "grafana.com",
  "substack.com",
  "medium.com",
  "linkedin.com",
  "twitter.com",
  "facebook.com",
  "instagram.com",
  "coursera.org",
  "maven.com",
  "udemy.com",
  "economictimesnews.com",
  "etprime.com",
  "getonecard.app",
  "hdfcbank.bank.in",
  "netflix.com",
  "amazon.in",
  "amazon.com",
  "flipkart.com",
  "zomato.com",
  "swiggy.com",
  "members.netflix.com",
  "mailers.hdfcbank.bank.in",
]);

const NEWSLETTER_LOCAL_PARTS = new Set([
  "noreply",
  "no-reply",
  "donotreply",
  "newsletter",
  "notifications",
  "mailer-daemon",
  "postmaster",
  "support",
  "info",
  "hello",
  "team",
  "marketing",
  "sales",
  "billing",
  "updates",
  "digest",
  "news",
  "alerts",
  "notify",
  "account-info",
  "service",
  "promo",
]);

/**
 * Check if an email is a newsletter or automated message.
 * Checks domain, local part, subdomain patterns, and Gmail labels.
 * @param {string} fromEmail — sender email address
 * @param {string[]} labels — Gmail label IDs
 * @returns {boolean}
 */
export function isNewsletter(fromEmail, labels) {
  if (!fromEmail) return false;

  const email = fromEmail.toLowerCase();
  const atIdx = email.indexOf("@");
  if (atIdx < 0) return false;

  const localPart = email.slice(0, atIdx);
  const domain = email.slice(atIdx + 1);

  // Check exact domain match
  if (NEWSLETTER_DOMAINS.has(domain)) return true;

  // Check subdomain match (e.g. mail.substack.com matches substack.com)
  for (const nd of NEWSLETTER_DOMAINS) {
    if (domain.endsWith("." + nd)) return true;
  }

  // Check local part
  if (NEWSLETTER_LOCAL_PARTS.has(localPart)) return true;

  // Check Gmail labels
  if (labels && labels.includes("CATEGORY_PROMOTIONS")) return true;

  return false;
}

/**
 * Parse an email address from "Name <email@example.com>" format.
 * Falls back to { name: "", email: raw } if no angle brackets.
 * @param {string} raw — raw From/To header value
 * @returns {{ name: string, email: string }}
 */
export function parseEmailAddress(raw) {
  if (!raw) return { name: "", email: "" };

  const match = raw.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) {
    return { name: match[1].trim().replace(/^"|"$/g, ""), email: match[2] };
  }

  return { name: "", email: raw.trim() };
}
