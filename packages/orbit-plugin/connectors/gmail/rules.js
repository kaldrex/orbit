// rules.js — Gmail message filtering rules for Orbit.
//
// Filters out newsletters, promotions, and automated emails so only
// real human conversations become signals.

const NEWSLETTER_DOMAINS = new Set([
  // Tech / content / social
  "nvidia.com", "google.com", "grafana.com", "substack.com", "medium.com",
  "linkedin.com", "twitter.com", "x.com", "facebook.com", "instagram.com",
  "youtube.com", "github.com", "gitlab.com", "vercel.com", "figma.com",
  "notion.so", "slack.com", "discord.com", "discordapp.com",
  // Learning platforms
  "coursera.org", "maven.com", "udemy.com", "edx.org", "skillshare.com",
  // News / media
  "economictimesnews.com", "etprime.com", "nytimes.com", "wsj.com", "bloomberg.net",
  // E-commerce
  "netflix.com", "amazon.in", "amazon.com", "flipkart.com", "zomato.com",
  "swiggy.com", "bigbasket.com", "blinkit.com", "zepto.co", "meesho.com",
  "myntra.com", "ajio.com", "cred.club", "mail.cred.club",
  // Banking / financial services
  "getonecard.app", "hdfcbank.bank.in", "icicibank.com", "sbi.co.in",
  "indusind.com", "axisbank.com", "kotak.com", "yesbank.in",
  "paytm.com", "phonepe.com", "razorpay.com", "juspay.in",
  "zerodha.com", "groww.in", "upstox.com", "angelone.in",
  // Travel / mobility
  "uber.com", "ola.co.in", "airbnb.com", "booking.com", "makemytrip.com",
  "goibibo.com", "cleartrip.com", "redbus.in", "irctc.co.in",
  // Dev / infra / SaaS noise
  "sentry.io", "datadoghq.com", "pagerduty.com", "amazonaws.com", "stripe.com",
  "intercom.io", "hubspot.com", "mailchimp.com", "sendgrid.net",
  // Community / Q&A
  "quora.com", "stackoverflow.com", "stackexchange.com",
  // Catch-all mailers
  "members.netflix.com", "mailers.hdfcbank.bank.in",
]);

const NEWSLETTER_LOCAL_PARTS = new Set([
  "noreply", "no-reply", "donotreply", "do-not-reply", "do_not_reply",
  "newsletter", "newsletters", "notifications", "notification",
  "mailer-daemon", "postmaster", "mailer", "auto-confirm",
  "support", "info", "hello", "team", "contact", "admin",
  "marketing", "sales", "billing", "invoice", "invoices", "receipts",
  "updates", "digest", "news", "alerts", "alert", "notify",
  "account-info", "account", "accounts", "service", "services",
  "promo", "promotions", "deals", "offers", "rewards", "care",
  "orders", "order", "shipping", "delivery", "tracking",
  "welcome", "onboarding", "help", "helpdesk", "feedback",
  "auto-reply", "auto", "bot", "system", "noticed",
]);

// Name keywords that scream "not a person" — used as display-name filter
const BUSINESS_NAME_KEYWORDS = [
  " inc", " llc", " ltd", " limited", " pvt", " corp", " co.",
  " bank", " broking", " capital", " securities", " insurance",
  " team", " support", " suggested spaces", " notifications",
  " mailer", " newsletter", " updates",
];

/**
 * Check if an email is a newsletter or automated message.
 * Checks domain, local part, subdomain patterns, and Gmail labels.
 * @param {string} fromEmail — sender email address
 * @param {string[]} labels — Gmail label IDs
 * @returns {boolean}
 */
export function isNewsletter(fromEmail, labels, displayName) {
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

  // Check local part — exact match first
  if (NEWSLETTER_LOCAL_PARTS.has(localPart)) return true;

  // Check if local part STARTS with any newsletter token (catches
  // account-info-123@, orders-12345@, etc.)
  for (const part of NEWSLETTER_LOCAL_PARTS) {
    if (localPart === part || localPart.startsWith(part + ".") ||
        localPart.startsWith(part + "-") || localPart.startsWith(part + "_")) {
      return true;
    }
  }

  // Check Gmail categorization labels — filter anything Gmail itself
  // marked as promotions, social, forums, or updates.
  if (labels) {
    if (labels.includes("CATEGORY_PROMOTIONS")) return true;
    if (labels.includes("CATEGORY_SOCIAL")) return true;
    if (labels.includes("CATEGORY_FORUMS")) return true;
    if (labels.includes("CATEGORY_UPDATES")) return true;
    if (labels.includes("SPAM")) return true;
  }

  // Check display name for business/organization indicators
  if (displayName) {
    const n = displayName.toLowerCase();
    for (const kw of BUSINESS_NAME_KEYWORDS) {
      if (n.includes(kw)) return true;
    }
  }

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
