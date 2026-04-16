// rules.js — Linear issue weighting rules for Orbit.
//
// Assigns signal weight based on issue state so active work generates
// stronger relationship signals than backlog items.

/**
 * Return a weight multiplier for an issue based on its state.
 * @param {string} state — issue state name (e.g. "In Progress", "Done")
 * @returns {number} weight between 0.0 and 1.0
 */
export function issueWeight(state) {
  if (!state) return 0.0;

  const s = state.toLowerCase();

  if (s === "active" || s === "in progress" || s === "in-progress") return 1.0;
  if (s === "done" || s === "completed" || s === "cancelled") return 0.5;
  if (s === "backlog" || s === "triage") return 0.3;

  return 0.0;
}
