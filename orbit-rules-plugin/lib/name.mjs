// Name resolution. pickBestName() is the single place where name
// candidates from all sources get ranked, safety-filtered, and collapsed
// to a single string (or null, meaning "no safe name available — let
// downstream decide").
//
// Source priority (highest wins):
//   1. wa_contact          — whatsapp address-book entry (push_name / full_name)
//   2. google_contact      — google contacts resource
//   3. gmail_from          — From-header on an email we received
//   4. gmail_to_cc         — To/Cc header
//   5. wa_group_sender     — sender_name on a group message (we SAW them send)
//   6. wa_message_sender   — sender_name on a DM message (push_name echo)
//   7. unknown             — fallback / placeholder
//
// Ties on priority are broken by LONGER STRING wins (preserves "Umayr
// Sheik" over "Umayr" when both are wa_contact).

import { safetyDropReason } from "./safety.mjs";

const PRIORITY = {
  wa_contact: 100,
  google_contact: 90,
  gmail_from: 80,
  gmail_to_cc: 70,
  wa_group_sender: 60,
  wa_message_sender: 55,
  unknown: 0,
};

function rankFor(source) {
  if (!source) return -1;
  const r = PRIORITY[source];
  return typeof r === "number" ? r : 0;
}

/**
 * @param {Array<{source: string, name: string}>} candidates
 * @returns {string | null}
 */
export function pickBestName(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  // Apply safety filter first — a phone-as-name never wins, even if it
  // carried a high-priority source flag.
  const safe = candidates.filter((c) => {
    if (!c || typeof c.name !== "string") return false;
    const reason = safetyDropReason({ name: c.name });
    return reason === null;
  });
  if (safe.length === 0) return null;

  // Sort by rank (desc), then by length (desc).
  safe.sort((a, b) => {
    const ra = rankFor(a.source);
    const rb = rankFor(b.source);
    if (rb !== ra) return rb - ra;
    return (b.name?.length ?? 0) - (a.name?.length ?? 0);
  });

  return safe[0].name.trim();
}

/**
 * Query sender_name hints from the wacli messages table for a given jid.
 * Returns candidates in descending count order (most-used push_name wins
 * ties). Caller is expected to attach `source: "wa_message_sender"` when
 * feeding these into pickBestName.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} jid — the sender_jid to look up (e.g. "911111111111@s.whatsapp.net")
 * @returns {Array<{name: string, count: number, ts_max: number}>}
 */
export function collectMessageSenderNames(db, jid) {
  if (!db || typeof jid !== "string" || !jid) return [];
  const rows = db
    .prepare(
      `SELECT sender_name AS name,
              COUNT(*)    AS count,
              MAX(ts)     AS ts_max
         FROM messages
        WHERE sender_jid = ?
          AND sender_name IS NOT NULL
          AND sender_name != ''
     GROUP BY sender_name
     ORDER BY count DESC, ts_max DESC
        LIMIT 3`,
    )
    .all(jid);
  return rows.map((r) => ({
    name: String(r.name ?? "").trim(),
    count: Number(r.count ?? 0),
    ts_max: Number(r.ts_max ?? 0),
  }));
}
