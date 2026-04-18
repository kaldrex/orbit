// Bulk backfill wacli.db → public.raw_events, one SQL round-trip at a
// time. This is the FAST PATH for historical imports.
//
// Why not use POST /api/v1/raw_events?
//   The HTTP route is right for live streaming (auth, validation, rate
//   limiting per plugin event). For a one-shot 33 k-row historical
//   import it's too many hops: Node → HTTP → Vercel → Supabase.rpc →
//   PostgREST → plpgsql for-loop → individual INSERTs. Tens of
//   thousands of rows through that path is minutes and prone to the
//   JSONB encoding bugs we hit in runs 1-4.
//
// This script goes directly through Supabase's Management API SQL
// endpoint, batching rows into multi-VALUES INSERT statements with
// ON CONFLICT DO NOTHING. Runs in one tight loop against real Postgres
// — no HTTP validation layer, no RPC interpreter.

import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

// ---- env ----------------------------------------------------------
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
  ...loadEnv(join(homedir(), ".orbit-bulk.env")),
  ...process.env,
};

const PROJECT_REF = env.SUPABASE_PROJECT_REF || "xrfcmjllsotkwxxkfamb";
const ACCESS_TOKEN = env.SUPABASE_ACCESS_TOKEN;
const USER_ID = env.ORBIT_USER_ID;
const DB_PATH = env.WACLI_DB || join(homedir(), ".wacli", "wacli.db");
const BATCH = Number(env.BULK_BATCH) || 1000;

if (!ACCESS_TOKEN) {
  console.error("SUPABASE_ACCESS_TOKEN required (your personal access token)");
  process.exit(2);
}
if (!USER_ID) {
  console.error(
    "ORBIT_USER_ID required. Find it via:\n" +
      '  SUPABASE_ACCESS_TOKEN=... curl https://api.supabase.com/v1/projects/<ref>/database/query \\\n' +
      '    -d \'{"query":"SELECT id FROM auth.users LIMIT 1"}\'',
  );
  process.exit(2);
}

// ---- SQL-safe encoding --------------------------------------------
// Single-quoted string. Handles NULs and unpaired UTF-16 surrogates
// (Postgres JSONB and TEXT both reject unpaired surrogates).
function safeSlice(s, n) {
  const arr = Array.from(String(s));
  return arr.slice(0, n).join("");
}
function sanitize(s) {
  if (s == null) return s;
  // Strip NULs and lone surrogates.
  return String(s)
    .replace(/\u0000/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
    .replace(/(?:[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g, "")
    .replace(/^[\uDC00-\uDFFF]/, "");
}
function sqlString(s) {
  if (s == null) return "NULL";
  return "'" + sanitize(s).replace(/'/g, "''") + "'";
}
function sqlJson(obj) {
  if (obj == null) return "NULL";
  // Serialize to JSON, then sanitize the resulting string as above.
  const raw = JSON.stringify(obj);
  return sqlString(raw) + "::jsonb";
}
function sqlArray(arr) {
  if (!arr || arr.length === 0) return "ARRAY[]::text[]";
  return "ARRAY[" + arr.map(sqlString).join(",") + "]";
}
function sqlTs(ms) {
  return "'" + new Date(ms).toISOString() + "'::timestamptz";
}

// ---- wacli row → SQL values tuple ---------------------------------
function rowToValues(r, userId) {
  const dir = r.from_me === 1 ? "'out'" : "'in'";
  const occurred = sqlTs(Number(r.ts) * 1000);
  const eventId = `${r.chat_jid}|${r.msg_id}`;
  const body = r.text || r.display_text || r.media_caption || null;
  const phone =
    r.sender_jid && /^\d+@s\.whatsapp\.net$/.test(r.sender_jid)
      ? "+" + r.sender_jid.split("@")[0]
      : null;
  const participants = r.sender_jid && r.sender_jid !== "self"
    ? [{ jid: r.sender_jid, name: sanitize(r.sender_name) ?? null }]
    : [];

  return (
    "(" +
    [
      `'${userId}'::uuid`,
      `'whatsapp'`,
      sqlString(eventId),
      `'whatsapp'`,
      sqlString("wacli-bulk-0.2"),
      occurred,
      dir,
      sqlString(r.chat_jid),
      sqlJson(participants),
      sqlArray(phone ? [phone] : []),
      sqlArray([]),
      sqlString(body ? safeSlice(body, 160) : null),
      r.media_type ? "true" : "false",
      sqlJson({
        chat_name: sanitize(r.chat_name),
        kind: r.kind ?? "unknown",
        msg_id: r.msg_id,
      }),
    ].join(", ") +
    ")"
  );
}

async function runSql(query) {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---- main ---------------------------------------------------------
console.log(`reading ${DB_PATH}`);
const db = new Database(DB_PATH, { readonly: true });
const allRows = db
  .prepare(
    `SELECT m.chat_jid, m.msg_id, m.sender_jid, m.sender_name, m.ts,
            m.from_me, m.text, m.display_text, m.media_caption,
            m.media_type, c.kind, m.chat_name
       FROM messages m
  LEFT JOIN chats c ON c.jid = m.chat_jid
       ORDER BY m.ts`,
  )
  .all();
console.log(`loaded ${allRows.length} rows; will upsert in batches of ${BATCH}`);

const cols =
  "(user_id, source, source_event_id, channel, connector_version, occurred_at, direction, thread_id, participants_raw, participant_phones, participant_emails, body_preview, attachments_present, raw_ref)";

let inserted = 0;
let failed = 0;
const start = Date.now();

for (let i = 0; i < allRows.length; i += BATCH) {
  const chunk = allRows.slice(i, i + BATCH);
  const values = chunk.map((r) => rowToValues(r, USER_ID)).join(",\n");
  const sql =
    `INSERT INTO public.raw_events ${cols}\nVALUES ${values}\n` +
    `ON CONFLICT (user_id, source, source_event_id) DO NOTHING\n` +
    `RETURNING id`;

  try {
    const result = await runSql(sql);
    const count = Array.isArray(result) ? result.length : 0;
    inserted += count;
    const pct = ((i + chunk.length) / allRows.length * 100).toFixed(1);
    const ratePerSec = Math.round(
      (i + chunk.length) / ((Date.now() - start) / 1000),
    );
    console.log(
      `  batch ${Math.floor(i / BATCH)}: +${count} (cum inserted=${inserted}, ${pct}%, ~${ratePerSec} rows/s)`,
    );
  } catch (e) {
    failed += chunk.length;
    console.error(`  batch ${Math.floor(i / BATCH)} FAILED: ${e.message}`);
  }
}

const total = (Date.now() - start) / 1000;
console.log(
  `\ndone in ${total.toFixed(1)}s: inserted=${inserted} failed=${failed}`,
);
db.close();
