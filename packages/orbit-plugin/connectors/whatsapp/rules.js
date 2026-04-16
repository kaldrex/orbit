// rules.js — WhatsApp message filtering rules for Orbit.
//
// Filters out spam, business/automated messages, group broadcasts,
// and status updates so only real human conversations become signals.

const SPAM_PATTERNS = [
  /(?:otp|code|verify|verification).*\b\d{4,8}\b|\b\d{4,8}\b.*(?:otp|code|verify|verification)/i, // OTP codes
  /(?:loan|credit)\s*(?:offer|approved|available|amount)/i, // Loan offers
  /(?:credit\s*card|card)\s*(?:statement|bill|due|payment)/i, // Credit card statements
  /(?:order|delivery)\s*(?:#|no|number|id)?[\s:]*\w+.*(?:track|status|shipped|dispatched)/i, // Order tracking
  /(?:insta\s*cash|instant\s*cash|cash\s*back|cashback)\s*(?:offer|reward|bonus|win)/i, // Insta cash
  /(?:shipment|package|parcel|courier)\b.*(?:track|status|update|delivered|dispatched)/i, // Shipment tracking
];

/**
 * Check if a message matches known spam patterns.
 * @param {string} text
 * @returns {boolean}
 */
export function isSpamMessage(text) {
  if (!text) return false;
  return SPAM_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Check if a JID belongs to a business/automated entity.
 * Matches toll-free numbers (91XXXXX00XXX pattern), broadcast lists,
 * and status updates.
 * @param {string} jid
 * @returns {boolean}
 */
export function isBusinessJid(jid) {
  if (!jid) return false;

  // Broadcast lists
  if (jid.includes("@broadcast")) return true;

  // Status updates
  if (jid.startsWith("status@")) return true;

  // Toll-free / business numbers: 91XXXXX00XXX pattern
  const phone = jid.split("@")[0];
  if (/^91\d{5}00\d{3}$/.test(phone)) return true;

  return false;
}

/**
 * Check if a JID is a group chat.
 * @param {string} jid
 * @returns {boolean}
 */
export function isGroupJid(jid) {
  if (!jid) return false;
  return jid.includes("@g.us");
}
