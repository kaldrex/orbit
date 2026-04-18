// Reads wacli.db messages table and produces raw_events rows. When run
// directly, batches and POSTs to /api/v1/raw_events.
//
// Pure `wacliToRawEvents` is test-harnessed against wacli-minimal.db.
// The CLI entry point at the bottom handles live import.

const DIRECTION_MAP = { inbound: "in", outbound: "out" };

export function wacliToRawEvents(db, { connectorVersion, skipIds } = {}) {
  const rows = db
    .prepare(
      `SELECT m.id, m.chat_jid, m.sender_jid, m.direction, m.body_preview, m.ts,
              c.is_group, c.name AS chat_name
         FROM messages m
    LEFT JOIN chats c ON c.jid = m.chat_jid
         ORDER BY m.ts`,
    )
    .all();

  const out = [];
  for (const r of rows) {
    if (skipIds && skipIds.has(r.id)) continue;
    const dir = DIRECTION_MAP[r.direction] ?? null;
    const occurred = new Date(Number(r.ts) * 1000).toISOString();
    const participants = [];
    if (r.sender_jid && r.sender_jid !== "self") {
      participants.push({ jid: r.sender_jid });
    }
    const phone =
      r.sender_jid && /^\d+@s\.whatsapp\.net$/.test(r.sender_jid)
        ? "+" + r.sender_jid.split("@")[0]
        : null;

    out.push({
      source: "whatsapp",
      source_event_id: r.id,
      channel: "whatsapp",
      connector_version: connectorVersion || "wacli-import-0.1",
      occurred_at: occurred,
      direction: dir,
      thread_id: r.chat_jid,
      participants_raw: participants,
      participant_phones: phone ? [phone] : [],
      participant_emails: [],
      body_preview: r.body_preview ? r.body_preview.slice(0, 160) : null,
      attachments_present: false,
      raw_ref: { chat_name: r.chat_name, is_group: Boolean(r.is_group) },
    });
  }
  return out;
}

async function postBatch(url, apiKey, rows) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST failed: ${res.status} ${text}`);
  }
  return res.json();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const Database = (await import("better-sqlite3")).default;
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");

  const dbPath = process.env.WACLI_DB || join(homedir(), ".wacli", "wacli.db");
  const apiUrl =
    process.env.ORBIT_API_URL || "https://orbit-mu-roan.vercel.app/api/v1";
  const apiKey = process.env.ORBIT_API_KEY;
  if (!apiKey) {
    console.error("ORBIT_API_KEY env required");
    process.exit(2);
  }

  const db = new Database(dbPath, { readonly: true });
  const all = wacliToRawEvents(db);
  console.log(`found ${all.length} rows; posting in batches of 500…`);

  let inserted = 0;
  let updated = 0;
  for (let i = 0; i < all.length; i += 500) {
    const chunk = all.slice(i, i + 500);
    const resp = await postBatch(`${apiUrl}/raw_events`, apiKey, chunk);
    inserted += resp.inserted || 0;
    updated += resp.updated || 0;
    console.log(
      `  batch ${Math.floor(i / 500)}: inserted=${resp.inserted} updated=${resp.updated}`,
    );
  }
  console.log(
    `done: total inserted=${inserted} updated=${updated} (updated = idempotent re-upserts)`,
  );
  db.close();
}
