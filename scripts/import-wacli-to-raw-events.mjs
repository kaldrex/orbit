// Reads wacli.db messages table and produces raw_events rows. When run
// directly, batches and POSTs to /api/v1/raw_events.
//
// Schema observed on claw (2026-04-18):
//   messages(rowid, chat_jid, chat_name, msg_id, sender_jid, sender_name,
//            ts, from_me, text, display_text, media_type, media_caption, ...)
//   chats(jid, kind, name, last_message_ts)         -- kind: dm|group|broadcast|unknown
//   contacts(jid, phone, push_name, full_name, first_name, business_name, updated_at)

export function wacliToRawEvents(db, { connectorVersion, skipIds } = {}) {
  const rows = db
    .prepare(
      `SELECT m.msg_id, m.chat_jid, m.chat_name, m.sender_jid, m.sender_name,
              m.ts, m.from_me,
              COALESCE(m.text, m.display_text, m.media_caption, '') AS body,
              m.media_type,
              c.kind
         FROM messages m
    LEFT JOIN chats c ON c.jid = m.chat_jid
         ORDER BY m.ts`,
    )
    .all();

  const out = [];
  for (const r of rows) {
    // Compound source_event_id: msg_id alone is not unique across chats.
    const eventId = `${r.chat_jid}|${r.msg_id}`;
    if (skipIds && skipIds.has(eventId)) continue;

    const dir = r.from_me === 1 ? "out" : "in";
    const occurred = new Date(Number(r.ts) * 1000).toISOString();
    const participants = [];
    if (r.sender_jid && r.sender_jid !== "self") {
      participants.push({ jid: r.sender_jid, name: r.sender_name ?? null });
    }
    const phone =
      r.sender_jid && /^\d+@s\.whatsapp\.net$/.test(r.sender_jid)
        ? "+" + r.sender_jid.split("@")[0]
        : null;

    out.push({
      source: "whatsapp",
      source_event_id: eventId,
      channel: "whatsapp",
      connector_version: connectorVersion || "wacli-import-0.1",
      occurred_at: occurred,
      direction: dir,
      thread_id: r.chat_jid,
      participants_raw: participants,
      participant_phones: phone ? [phone] : [],
      participant_emails: [],
      body_preview: r.body ? String(r.body).slice(0, 160) : null,
      attachments_present: Boolean(r.media_type),
      raw_ref: {
        chat_name: r.chat_name,
        kind: r.kind ?? "unknown",
        msg_id: r.msg_id,
      },
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
  const text = await res.text();
  if (!res.ok) throw new Error(`POST failed: ${res.status} ${text}`);
  return JSON.parse(text);
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
  const batchSize = Number(process.env.BATCH_SIZE) || 200;
  const retries = Number(process.env.RETRIES) || 3;
  console.log(`found ${all.length} rows; posting in batches of ${batchSize} (retries=${retries})…`);

  let inserted = 0;
  let updated = 0;
  let failures = 0;
  for (let i = 0; i < all.length; i += batchSize) {
    const chunk = all.slice(i, i + batchSize);
    let attempt = 0;
    let ok = false;
    while (attempt <= retries && !ok) {
      try {
        const resp = await postBatch(`${apiUrl}/raw_events`, apiKey, chunk);
        inserted += resp.inserted || 0;
        updated += resp.updated || 0;
        ok = true;
        if (i % (batchSize * 25) === 0 || i + batchSize >= all.length) {
          console.log(
            `  row ${i}: inserted=${resp.inserted} updated=${resp.updated} (cum ins=${inserted} upd=${updated})`,
          );
        }
      } catch (e) {
        attempt += 1;
        const backoff = 500 * Math.pow(2, attempt);
        console.warn(`  row ${i} attempt ${attempt} failed: ${e.message}; sleep ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    if (!ok) {
      failures += chunk.length;
      console.error(`  row ${i} GAVE UP after ${retries + 1} attempts`);
    }
  }
  console.log(
    `done: total inserted=${inserted} updated=${updated} failures=${failures}`,
  );
  db.close();
}
