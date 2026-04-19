import Database from "better-sqlite3";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_DB = path.join(os.homedir(), ".wacli", "session.db");

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
  const cleaned = rawLid.replace(/@lid$/i, "").trim();
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
