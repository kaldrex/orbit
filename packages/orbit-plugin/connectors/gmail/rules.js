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

const AUTOMATED_CONTENT_PATTERNS = [
  /pushed \d+ commits?/i,
  /opened (?:an?|the)?\s*(?:issue|pull request)/i,
  /merged (?:an?|the)?\s*pull request/i,
  /review(?:ed)? .*pull request/i,
  /commented on .*pull request/i,
  /view it on github/i,
  /you are receiving this because/i,
  /notification settings/i,
  /unsubscribe from this/i,
  /verification code/i,
  /one[- ]time password/i,
  /reset your password/i,
  /\border\b.*\b(?:shipped|delivered|out for delivery|dispatched)\b/i,
  /\binvoice\b/i,
  /\breceipt\b/i,
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
 * Conservative check for whether a mailbox participant looks like a real
 * human counterparty rather than a system or mailing identity.
 * @param {string} email
 * @param {string[]} labels
 * @param {string} displayName
 * @returns {boolean}
 */
export function isHumanContact(email, labels = [], displayName = "") {
  if (!email) return false;
  return !isNewsletter(email, labels, displayName);
}

function decodeBodyData(data) {
  if (!data) return "";
  const padded = data + "=".repeat((4 - (data.length % 4)) % 4);
  try {
    return Buffer.from(padded, "base64url").toString("utf8");
  } catch {
    try {
      return Buffer.from(padded, "base64").toString("utf8");
    } catch {
      return "";
    }
  }
}

function htmlToText(html) {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function collectBodyParts(node, acc) {
  if (!node || typeof node !== "object") return;

  const mimeType = node.mimeType || "";
  const bodyText = decodeBodyData(node.body?.data);
  if (mimeType === "text/plain" && bodyText) acc.plain.push(bodyText);
  if (mimeType === "text/html" && bodyText) acc.html.push(bodyText);

  for (const part of node.parts || []) {
    collectBodyParts(part, acc);
  }
}

/**
 * Extract the best available body text from a Gmail payload.
 * @param {Record<string, any>} payload
 * @returns {{ textPlain: string, textHtml: string, text: string }}
 */
export function extractMessageBody(payload) {
  const acc = { plain: [], html: [] };
  collectBodyParts(payload, acc);

  const textPlain = acc.plain.find((x) => x.trim()) || "";
  const textHtml = acc.html.find((x) => x.trim()) || "";
  const text = textPlain || htmlToText(textHtml);

  return { textPlain, textHtml, text };
}

/**
 * Detect content that is obviously automated/operational noise even if the
 * sender survives address-based filtering.
 * @param {string} subject
 * @param {string} snippet
 * @param {string} bodyText
 * @returns {boolean}
 */
export function isAutomatedContent(subject = "", snippet = "", bodyText = "") {
  const hay = `${subject}\n${snippet}\n${bodyText}`.trim();
  if (!hay) return false;
  return AUTOMATED_CONTENT_PATTERNS.some((pattern) => pattern.test(hay));
}

/**
 * Build a compact, human-readable summary string from the best available
 * subject/snippet/body fields.
 * @param {{ subject?: string, snippet?: string, bodyText?: string }} parts
 * @returns {string | undefined}
 */
export function buildEmailDetail({ subject = "", snippet = "", bodyText = "" }) {
  const pick =
    snippet.trim() ||
    bodyText.trim().split(/\r?\n/).map((line) => line.trim()).find(Boolean) ||
    subject.trim();

  if (!pick) return undefined;
  return pick.length > 240 ? `${pick.slice(0, 237)}...` : pick;
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
