// Genuinely fast path: direct Postgres COPY FROM STDIN (CSV) via the
// session pooler (port 5432). One connection, one transaction, no HTTP
// hops, no PostgREST, no plpgsql loop. Expected: under 10 seconds for
// 33 k rows.
//
// Prereqs: SUPABASE_DB_URL, WACLI_DB, ORBIT_USER_ID.
//
// Two layers:
//   wacliToRawEvents(db, opts)  -> pure fn, returns native JS row objs
//                                  (raw_ref as object, booleans real,
//                                   arrays real). Shape matches
//                                   rawEventsBatchSchema. Exported so
//                                   tests can validate the mapping
//                                   without touching Postgres.
//   toCsvLine(row, userId)      -> serializes one row to a COPY CSV line
//                                  (jsonb/text[] encoded for Postgres).
//   main()                      -> opens wacli.db, streams COPY into
//                                  staging, UPSERTs to final. Runs only
//                                  when this file is the node entrypoint.

import Database from "better-sqlite3";
import pg from "pg";
import copyStreams from "pg-copy-streams";
import { once } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

// ---- UTF-8 safety --------------------------------------------------
// Postgres TEXT/JSONB reject NULs and unpaired UTF-16 surrogates.
// Strip both before writing.
export function cleanString(s) {
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

// ---- wacli row -> raw_event row (pure) ----------------------------
// Returns an array of raw_event objects matching rawEventsBatchSchema.
// No Postgres, no side effects. Tests consume this directly.
export function wacliToRawEvents(db, opts = {}) {
  const connectorVersion = opts.connectorVersion ?? "wacli-bulk-0.3-copy";
  const skipIds = opts.skipIds ?? null;

  const rows = db
    .prepare(
      `SELECT m.chat_jid, m.msg_id, m.sender_jid, m.sender_name, m.ts,
              m.from_me, m.text, m.display_text, m.media_caption,
              m.media_type, c.kind, m.chat_name
         FROM messages m
    LEFT JOIN chats c ON c.jid = m.chat_jid
         ORDER BY m.ts`,
    )
    .all();

  const out = [];
  for (const r of rows) {
    const eventId = `${r.chat_jid}|${r.msg_id}`;
    if (skipIds && skipIds.has(eventId)) continue;

    const body = r.text || r.display_text || r.media_caption || null;
    const direction = r.from_me === 1 ? "out" : "in";
    const occurredAt = new Date(Number(r.ts) * 1000).toISOString();
    const phone =
      r.sender_jid && /^\d+@s\.whatsapp\.net$/.test(r.sender_jid)
        ? "+" + r.sender_jid.split("@")[0]
        : null;
    const participantsRaw =
      r.sender_jid && r.sender_jid !== "self"
        ? [{ jid: r.sender_jid, name: cleanString(r.sender_name) }]
        : [];

    out.push({
      source: "whatsapp",
      source_event_id: eventId,
      channel: "whatsapp",
      connector_version: connectorVersion,
      occurred_at: occurredAt,
      direction,
      thread_id: r.chat_jid,
      participants_raw: participantsRaw,
      participant_phones: phone ? [phone] : [],
      participant_emails: [],
      body_preview: safeSlice(cleanString(body), 160),
      attachments_present: Boolean(r.media_type),
      raw_ref: {
        chat_name: cleanString(r.chat_name),
        kind: r.kind ?? "unknown",
        msg_id: r.msg_id,
      },
    });
  }
  return out;
}

// ---- CSV encoding (matching Postgres CSV defaults) ----------------
// Double-quote whole fields, escape `"` by doubling, keep newlines.
function csv(v) {
  if (v == null) return "";
  const s = typeof v === "string" ? v : String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}
function pgArrayText(arr) {
  if (!arr || arr.length === 0) return "{}";
  // Postgres text[] literal: {"a","b"} - escape backslash + quote inside.
  const parts = arr.map((x) =>
    '"' + String(x).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"',
  );
  return "{" + parts.join(",") + "}";
}

// ---- one raw_event row -> one COPY CSV line ----------------------
// Column order must match the COPY column list in main().
function toCsvLine(row, userId) {
  return [
    csv(userId),                                        // user_id uuid (text-cast)
    csv(row.source),                                    // source
    csv(row.source_event_id),                           // source_event_id
    csv(row.channel),                                   // channel
    csv(row.connector_version),                         // connector_version
    csv(row.occurred_at),                               // occurred_at
    csv(row.direction),                                 // direction
    csv(row.thread_id),                                 // thread_id
    csv(JSON.stringify(row.participants_raw)),          // participants_raw (jsonb)
    csv(pgArrayText(row.participant_phones)),           // participant_phones
    csv(pgArrayText(row.participant_emails)),           // participant_emails
    csv(row.body_preview),                              // body_preview
    row.attachments_present ? '"t"' : '"f"',            // attachments_present
    csv(JSON.stringify(row.raw_ref)),                   // raw_ref (jsonb)
  ].join(",");
}

// ---- env loader (script entrypoint only) --------------------------
function loadEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// ---- main ---------------------------------------------------------
async function main() {
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

  const sql = Database(DB_PATH, { readonly: true });
  const rawRows = wacliToRawEvents(sql);
  console.log(`read ${rawRows.length} rows from wacli.db`);

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
  for (const r of rawRows) {
    if (!stream.write(toCsvLine(r, USER_ID) + "\n")) {
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
}

// Only run main() when invoked as an entrypoint (node path/to/this.mjs).
// When imported by tests, this guard prevents auto-connecting to Postgres.
const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await main();
}
