// Genuinely fast path: direct Postgres COPY FROM STDIN (CSV) via the
// session pooler (port 5432). One connection, one transaction, no HTTP
// hops, no PostgREST, no plpgsql loop. Expected: under 10 seconds for
// 33 k rows.
//
// Prereqs: SUPABASE_DB_URL, WACLI_DB, ORBIT_USER_ID.

import Database from "better-sqlite3";
import pg from "pg";
import copyStreams from "pg-copy-streams";
import { once } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

function loadEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const env = {
  ...loadEnv(join(process.cwd(), ".env.local")),
  ...process.env,
};
const DB_URL = env.SUPABASE_DB_URL;
const USER_ID = env.ORBIT_USER_ID;
const DB_PATH = env.WACLI_DB || join(homedir(), ".wacli", "wacli.db");

if (!DB_URL) {
  console.error("SUPABASE_DB_URL required");
  process.exit(2);
}
if (!USER_ID) {
  console.error("ORBIT_USER_ID required");
  process.exit(2);
}

// ---- UTF-8 safety --------------------------------------------------
// Postgres TEXT/JSONB reject NULs and unpaired UTF-16 surrogates.
// Strip both before writing.
function cleanString(s) {
  if (s == null) return null;
  return String(s)
    .replace(/\u0000/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
    .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "$1");
}
function safeSlice(s, n) {
  if (s == null) return null;
  const arr = Array.from(String(s));
  return arr.slice(0, n).join("");
}

// ---- CSV encoding (matching Postgres CSV defaults) ----------------
// Double-quote whole fields, escape `"` by doubling, keep newlines.
function csv(v) {
  if (v == null) return "";
  const s = typeof v === "string" ? v : String(v);
  // Quote everything non-trivial; cheap and robust.
  return '"' + s.replace(/"/g, '""') + '"';
}
function pgArrayText(arr) {
  if (!arr || arr.length === 0) return "{}";
  // Postgres text[] literal: {"a","b"} — escape backslash + quote inside.
  const parts = arr.map((x) =>
    '"' + String(x).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"',
  );
  return "{" + parts.join(",") + "}";
}

// ---- wacli row → CSV line -----------------------------------------
// Columns must match the COPY column list below.
function toCsv(r, userId) {
  const body = r.text || r.display_text || r.media_caption || null;
  const dir = r.from_me === 1 ? "out" : "in";
  const occurred = new Date(Number(r.ts) * 1000).toISOString();
  const eventId = `${r.chat_jid}|${r.msg_id}`;
  const phone =
    r.sender_jid && /^\d+@s\.whatsapp\.net$/.test(r.sender_jid)
      ? "+" + r.sender_jid.split("@")[0]
      : null;
  const participants =
    r.sender_jid && r.sender_jid !== "self"
      ? [{ jid: r.sender_jid, name: cleanString(r.sender_name) }]
      : [];

  const rawRef = {
    chat_name: cleanString(r.chat_name),
    kind: r.kind ?? "unknown",
    msg_id: r.msg_id,
  };

  return [
    csv(userId),                                  // user_id uuid (text-cast in COPY)
    csv("whatsapp"),                              // source
    csv(eventId),                                 // source_event_id
    csv("whatsapp"),                              // channel
    csv("wacli-bulk-0.3-copy"),                   // connector_version
    csv(occurred),                                // occurred_at
    csv(dir),                                     // direction
    csv(r.chat_jid),                              // thread_id
    csv(JSON.stringify(participants)),            // participants_raw (jsonb)
    csv(pgArrayText(phone ? [phone] : [])),       // participant_phones
    csv(pgArrayText([])),                         // participant_emails
    csv(safeSlice(cleanString(body), 160)),       // body_preview
    r.media_type ? '"t"' : '"f"',                 // attachments_present
    csv(JSON.stringify(rawRef)),                  // raw_ref (jsonb)
  ].join(",");
}

// ---- main ---------------------------------------------------------
const sql = Database(DB_PATH, { readonly: true });
const rows = sql
  .prepare(
    `SELECT m.chat_jid, m.msg_id, m.sender_jid, m.sender_name, m.ts,
            m.from_me, m.text, m.display_text, m.media_caption,
            m.media_type, c.kind, m.chat_name
       FROM messages m
  LEFT JOIN chats c ON c.jid = m.chat_jid
       ORDER BY m.ts`,
  )
  .all();
console.log(`read ${rows.length} rows from wacli.db`);

const client = new pg.Client({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: false }, // pooler cert chain
});
await client.connect();

const t0 = Date.now();

// Stage into a TEMP table first; UPSERT to final. This lets us keep a
// clean ON CONFLICT DO NOTHING without fighting COPY's "every row must
// succeed" semantics.
await client.query("BEGIN");
await client.query(
  `CREATE TEMP TABLE IF NOT EXISTS raw_events_staging
     (LIKE public.raw_events INCLUDING DEFAULTS)
     ON COMMIT DROP`,
);
await client.query(`ALTER TABLE raw_events_staging DROP CONSTRAINT IF EXISTS raw_events_pkey`);
await client.query(`ALTER TABLE raw_events_staging DROP CONSTRAINT IF EXISTS raw_events_user_id_source_source_event_id_key`);

const copySql = `COPY raw_events_staging
  (user_id, source, source_event_id, channel, connector_version,
   occurred_at, direction, thread_id, participants_raw,
   participant_phones, participant_emails, body_preview,
   attachments_present, raw_ref)
  FROM STDIN WITH (FORMAT csv)`;

const stream = client.query(copyStreams.from(copySql));
for (const r of rows) {
  if (!stream.write(toCsv(r, USER_ID) + "\n")) {
    await once(stream, "drain");
  }
}
stream.end();
await once(stream, "finish");
const tCopy = Date.now();

const { rows: upsertRes } = await client.query(
  `INSERT INTO public.raw_events
     (id, user_id, source, source_event_id, channel, connector_version,
      occurred_at, ingested_at, direction, thread_id,
      participants_raw, participant_phones, participant_emails,
      body_preview, attachments_present, raw_ref)
   SELECT
     COALESCE(id, gen_random_uuid()),
     user_id, source, source_event_id, channel, connector_version,
     occurred_at, COALESCE(ingested_at, now()), direction, thread_id,
     participants_raw, participant_phones, participant_emails,
     body_preview, attachments_present, raw_ref
   FROM raw_events_staging
   ON CONFLICT (user_id, source, source_event_id) DO NOTHING
   RETURNING id`,
);

await client.query("COMMIT");

const tDone = Date.now();
console.log(
  `COPY to staging: ${((tCopy - t0) / 1000).toFixed(2)}s\n` +
    `  UPSERT final:  ${((tDone - tCopy) / 1000).toFixed(2)}s\n` +
    `  total:         ${((tDone - t0) / 1000).toFixed(2)}s\n` +
    `  inserted:      ${upsertRes.length}`,
);

await client.end();
sql.close();
