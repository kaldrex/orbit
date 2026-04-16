// rules.js — Calendar event filtering and recurring-event collapse for Orbit.
//
// Filters auto-generated events (flights, reminders, birthdays), events too
// far in the future, oversized meetings, and collapses recurring series into
// a single representative signal.

const AUTO_EVENT_PATTERNS = [
  /\bflight\b/i,
  /\bhotel\b/i,
  /\bcheck[\s-]?in\b/i,
  /\bcheck[\s-]?out\b/i,
  /\bpickup\b/i,
  /\bdrop[\s-]?off\b/i,
  /\breminder\b/i,
  /\bbirthday\b/i,
  /\banniversary\b/i,
  /\bbill\s+due\b/i,
  /\brenewal\b/i,
  /\bsubscription\b/i,
];

const MAX_FUTURE_DAYS = 180;
const MAX_ATTENDEES = 8;

/**
 * Check if an event is auto-generated (flight, reminder, birthday, etc.)
 * or has no attendees (personal reminder/block).
 * @param {string} summary — event title
 * @param {number} attendeeCount
 * @returns {boolean}
 */
export function isAutoEvent(summary, attendeeCount) {
  if (attendeeCount === 0) return true;
  if (!summary) return false;
  return AUTO_EVENT_PATTERNS.some((p) => p.test(summary));
}

/**
 * Check if an event is more than 180 days in the future.
 * @param {string} startTimeStr — ISO timestamp
 * @returns {boolean}
 */
export function isTooFarFuture(startTimeStr) {
  if (!startTimeStr) return false;
  const start = new Date(startTimeStr);
  const cutoff = new Date(Date.now() + MAX_FUTURE_DAYS * 86400_000);
  return start > cutoff;
}

/**
 * Check if an event has too many attendees (>8).
 * @param {number} attendeeCount
 * @returns {boolean}
 */
export function isTooLarge(attendeeCount) {
  return attendeeCount > MAX_ATTENDEES;
}

/**
 * Collapse recurring events into a single representative signal.
 *
 * Groups events by (sorted attendee emails + normalized title). For groups
 * with 3+ events, checks interval regularity: sort timestamps, compute
 * intervals, find median, check if 60%+ are within 0.5x-1.5x of median.
 * If recurring, keeps only the most recent event with metadata.
 *
 * @param {Array<Object>} events — array of calendar event objects
 * @returns {Array<Object>} collapsed events
 */
export function collapseRecurring(events) {
  if (!events || events.length === 0) return [];

  // Group by key = sorted attendee emails + normalized title
  const groups = new Map();
  for (const ev of events) {
    const emails = (ev._attendeeEmails || []).slice().sort().join(",");
    const title = (ev.summary || "").toLowerCase().trim();
    const key = `${emails}|${title}`;

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ev);
  }

  const result = [];

  for (const [, group] of groups) {
    if (group.length < 3) {
      // Not enough events to detect recurrence — pass through
      result.push(...group);
      continue;
    }

    // Sort by start time
    group.sort(
      (a, b) =>
        new Date(a.start?.dateTime || a.start?.date).getTime() -
        new Date(b.start?.dateTime || b.start?.date).getTime()
    );

    // Compute intervals between consecutive events
    const timestamps = group.map(
      (e) => new Date(e.start?.dateTime || e.start?.date).getTime()
    );
    const intervals = [];
    for (let i = 1; i < timestamps.length; i++) {
      intervals.push(timestamps[i] - timestamps[i - 1]);
    }

    // Find median interval
    const sorted = intervals.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    // Check if 60%+ of intervals are within 0.5x-1.5x of median
    const regularCount = intervals.filter(
      (iv) => iv >= median * 0.5 && iv <= median * 1.5
    ).length;

    const isRegular = regularCount / intervals.length >= 0.6;

    if (!isRegular) {
      // Not recurring — pass through all
      result.push(...group);
      continue;
    }

    // Recurring — keep only the most recent event
    const mostRecent = group[group.length - 1];
    const medianDays = median / 86400_000;

    let cadence;
    if (medianDays < 3) cadence = "daily";
    else if (medianDays < 10) cadence = "weekly";
    else if (medianDays < 21) cadence = "biweekly";
    else cadence = "monthly";

    mostRecent._recurring = true;
    mostRecent._cadence = cadence;
    mostRecent._occurrences = group.length;
    result.push(mostRecent);
  }

  return result;
}
