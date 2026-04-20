import Database from "better-sqlite3";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_DB = path.join(os.homedir(), ".wacli", "session.db");

/**
 * Canonicalize a WhatsApp LID to its bare numeric identifier.
 * Strips both the "@lid" suffix and any ":<device>" suffix.
 *   "10307938324603:28@lid"  → "10307938324603"
 *   "10307938324603:30"      → "10307938324603"
 *   "10307938324603@lid"     → "10307938324603"
 *   "10307938324603"         → "10307938324603"
 *   ""  / null / undefined   → null
 */
export function bareLid(jid) {
  if (jid === null || jid === undefined) return null;
  if (typeof jid !== "string") return null;
  const s = jid.trim();
  if (!s) return null;
  // Strip trailing "@lid" (case-insensitive)
  let t = s.replace(/@lid$/i, "");
  // Strip trailing ":<device>" suffix (one or more digits)
  t = t.replace(/:\d+$/, "");
  t = t.trim();
  return t || null;
}

// Cache DB handles so we don't re-open on every call. Invalidate if
// file mtime changes (catches concurrent wacli writes).
const handles = new Map();

function openDb(dbPath) {
  const cached = handles.get(dbPath);
  if (cached) {
    try {
      const mtime = statSync(dbPath).mtimeMs;
      if (mtime === cached.mtime) return cached.db;
      try {
        cached.db.close();
      } catch {}
      handles.delete(dbPath);
    } catch {
      handles.delete(dbPath);
    }
  }
  if (!existsSync(dbPath)) {
    throw new Error(`whatsmeow session.db not found at ${dbPath}`);
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const entry = { db, mtime: statSync(dbPath).mtimeMs };
  handles.set(dbPath, entry);
  return db;
}

/**
 * Look up a phone number for a given WhatsApp LID via
 * whatsmeow_lid_map in session.db. The map is written by wacli/whatsmeow
 * when it observes group participants; each LID (newer identity token)
 * is paired with a pn (phone number, digits only, no '+').
 *
 * Input:
 *   lid: the LID string. Accepts both "207283862659127" and "207283862659127@lid".
 *   lid_map_source: optional override; default "wacli_session_db".
 *
 * Output:
 *   { phone: "+971586783040" | null, source_path: "<resolved path>" }
 *
 * Never writes. Opens the DB in read-only mode.
 */
export function lidToPhone({ lid, lid_map_source, db_path_override }) {
  const rawLid = lid ?? "";
  if (!rawLid || typeof rawLid !== "string") {
    return { phone: null, source_path: null };
  }
  const cleaned = bareLid(rawLid);
  if (!cleaned) {
    return { phone: null, source_path: null };
  }

  const dbPath =
    db_path_override ||
    process.env.WACLI_SESSION_DB ||
    (lid_map_source === "wacli_session_db" ? DEFAULT_DB : DEFAULT_DB);

  const db = openDb(dbPath);
  const row = db
    .prepare("SELECT pn FROM whatsmeow_lid_map WHERE lid = ? LIMIT 1")
    .get(cleaned);

  if (!row || !row.pn) {
    return { phone: null, source_path: dbPath };
  }

  // whatsmeow stores phone numbers as digits-only; add leading + for E.164.
  const pn = String(row.pn).trim();
  const e164 = pn.startsWith("+") ? pn : `+${pn}`;
  return { phone: e164, source_path: dbPath };
}

// ---------------------------------------------------------------------------
// Positive-source LID rule: for @lid jids, session.db's whatsmeow_lid_map is
// the ONLY valid phone source. Ignore `contacts.phone` entirely — recon
// found 9,948 contacts with `phone = LID digits` re-echoed, which caused 31
// cross-identity wrong-merges.
//
// Accepts either:
//   - { row, lidMap }         — lidMap is a Map<lidString, "+E164">
//   - { row, db_path_override } — we look up via session.db directly
//
// Returns E.164 string or null.
// ---------------------------------------------------------------------------
export function phoneForContact({ row, lidMap, db_path_override, lid_map_source }) {
  if (!row || typeof row !== "object") return null;
  const jid = String(row.jid ?? "");
  if (!jid) return null;

  if (jid.endsWith("@lid")) {
    const bare = bareLid(jid);
    if (!bare) return null;
    if (lidMap) {
      const v = lidMap.get(bare);
      if (!v) return null;
      return v.startsWith("+") ? v : `+${v}`;
    }
    // fall back to db lookup
    const r = lidToPhone({ lid: bare, lid_map_source, db_path_override });
    return r.phone ?? null;
  }

  if (jid.endsWith("@s.whatsapp.net")) {
    // plain wa jid — row.phone is the canonical phone. Caller should still
    // normalize via phone.mjs.
    const raw = row.phone ?? jid.slice(0, -"@s.whatsapp.net".length);
    if (!raw) return null;
    const s = String(raw).trim();
    if (!s) return null;
    return s.startsWith("+") ? s : `+${s}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Seed filter: drop unresolvable @lid contact rows at ingress.
//
// An @lid contact is UNRESOLVABLE (a "ghost") when:
//   - jid ends in @lid AND
//   - full_name/push_name/first_name are all empty AND
//   - lidMap has no entry for the bare LID
//
// These rows contribute zero identity signal and cause 4,985 orphan buckets
// in the wild — we drop them at the earliest possible stage.
// ---------------------------------------------------------------------------
export function isResolvableLidContact(row, lidMap) {
  if (!row || typeof row !== "object") return false;
  const jid = String(row.jid ?? "");
  if (!jid.endsWith("@lid")) return true; // non-lid rows pass through

  const bare = bareLid(jid);
  const name =
    (row.full_name && String(row.full_name).trim()) ||
    (row.push_name && String(row.push_name).trim()) ||
    (row.first_name && String(row.first_name).trim()) ||
    "";

  if (name) return true;
  if (lidMap && bare && lidMap.has(bare)) return true;
  return false;
}
