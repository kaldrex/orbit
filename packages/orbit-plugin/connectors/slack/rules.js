// rules.js — Slack message filtering rules for Orbit.
//
// Filters out bot messages and known agent accounts so only real
// human conversations become signals.

const KNOWN_AGENTS = new Set([
  "wazowski",
  "chad",
  "axe",
  "kite",
  "slackbot",
]);

/**
 * Check if a Slack member is a bot or known agent.
 * @param {Object} member — Slack user object or event with user info
 * @returns {boolean}
 */
export function isBot(member) {
  if (!member) return false;

  // Slack API is_bot flag
  if (member.is_bot) return true;

  // USLACKBOT is a special system user
  if (member.id === "USLACKBOT") return true;

  // Check against known agent names
  const name = (
    member.name ||
    member.real_name ||
    member.profile?.display_name ||
    ""
  ).toLowerCase();

  return KNOWN_AGENTS.has(name);
}
