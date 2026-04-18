// Produces tests/fixtures/wacli-minimal.db matching the REAL wacli.db
// schema observed on claw (see docs/handoff or run `.schema` against a
// real wacli.db). Key departures from an earlier guess:
//   messages:          rowid + msg_id + from_me + text (not id/direction/body_preview)
//   chats:             kind enum (dm|group|broadcast|unknown), not is_group
//   group_participants: user_jid, not member_jid
// The fixture mirrors the real schema so the importer tests exercise
// the same SQL that runs in prod.

import Database from "better-sqlite3";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = resolve(__dirname, "wacli-minimal.db");
try { rmSync(out); } catch {}

const db = new Database(out);
db.pragma("journal_mode = WAL");

const SCHEMA = [
  `CREATE TABLE chats (
     jid TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     name TEXT,
     last_message_ts INTEGER
   )`,
  `CREATE TABLE messages (
     rowid INTEGER PRIMARY KEY AUTOINCREMENT,
     chat_jid TEXT NOT NULL,
     chat_name TEXT,
     msg_id TEXT NOT NULL,
     sender_jid TEXT,
     sender_name TEXT,
     ts INTEGER NOT NULL,
     from_me INTEGER NOT NULL,
     text TEXT,
     display_text TEXT,
     media_type TEXT,
     media_caption TEXT,
     UNIQUE(chat_jid, msg_id)
   )`,
  `CREATE TABLE contacts (
     jid TEXT PRIMARY KEY,
     phone TEXT,
     push_name TEXT,
     full_name TEXT,
     first_name TEXT,
     business_name TEXT,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE group_participants (
     group_jid TEXT NOT NULL,
     user_jid TEXT NOT NULL,
     role TEXT,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (group_jid, user_jid)
   )`,
];
for (const stmt of SCHEMA) db.prepare(stmt).run();

const iChat = db.prepare("INSERT INTO chats VALUES (?,?,?,?)");
const iMsg  = db.prepare(
  "INSERT INTO messages (chat_jid, chat_name, msg_id, sender_jid, sender_name, ts, from_me, text, display_text, media_type, media_caption) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
);
const iCon  = db.prepare("INSERT INTO contacts VALUES (?,?,?,?,?,?,?)");
const iGP   = db.prepare("INSERT INTO group_participants VALUES (?,?,?,?)");

const now = Math.floor(Date.now() / 1000);

const contacts = [
  ["911111111111@s.whatsapp.net", "+911111111111", null,       "Alice Kumar",   "Alice",  null,           now],
  ["912222222222@s.whatsapp.net", "+912222222222", "Bobby",    "Bob Singh",     "Bob",    null,           now],
  ["913333333333@s.whatsapp.net", "+913333333333", "Charlie",  null,            null,     null,           now],
  ["914444444444@s.whatsapp.net", "+914444444444", null,       null,            null,     "Dee's Bakery", now],
  ["915555555555@s.whatsapp.net", "+915555555555", null,       "Eve Thakur",    "Eve",    null,           now],
];
for (const c of contacts) iCon.run(...c);

const chats = [
  ["911111111111@s.whatsapp.net",     "dm",    "Alice Kumar",  1_713_400_000],
  ["912222222222@s.whatsapp.net",     "dm",    "Bobby",        1_713_410_000],
  ["913333333333@s.whatsapp.net",     "dm",    "Charlie",      1_713_420_000],
  ["914444444444@s.whatsapp.net",     "dm",    "Dee's Bakery", 1_713_430_000],
  ["915555555555@s.whatsapp.net",     "dm",    "Eve Thakur",   1_713_440_000],
  ["916666666666@s.whatsapp.net",     "dm",    null,           1_713_450_000],
  ["120363000000000001@g.us",         "group", "Team Orbit",   1_713_460_000],
  ["120363000000000002@g.us",         "group", "YC W26",       1_713_470_000],
  ["99999999@lid",                    "unknown", null,         1_713_480_000],
  ["88888888@lid",                    "unknown", null,         1_713_490_000],
];
for (const c of chats) iChat.run(...c);

const pushMsg = (chat, chatName, msgId, sender, senderName, ts, fromMe, text) =>
  iMsg.run(chat, chatName, msgId, sender, senderName, ts, fromMe, text, text, null, null);

let msgCounter = 0;
for (const dmChat of chats.slice(0, 6)) {
  for (let i = 0; i < 5; i++) {
    const id = `msg-${String(++msgCounter).padStart(4, "0")}`;
    pushMsg(
      dmChat[0], dmChat[2], id,
      i % 2 === 0 ? dmChat[0] : null,
      i % 2 === 0 ? dmChat[2] : null,
      dmChat[3] + i * 60,
      i % 2 === 0 ? 0 : 1,
      `hello ${i}`,
    );
  }
}
for (const groupChat of chats.slice(6, 8)) {
  for (let i = 0; i < 10; i++) {
    const id = `msg-${String(++msgCounter).padStart(4, "0")}`;
    const who = contacts[i % 5];
    pushMsg(
      groupChat[0], groupChat[2], id,
      who[0], who[3] || who[4] || who[2],
      groupChat[3] + i * 60,
      0,
      `group msg ${i}`,
    );
  }
}

const g1 = "120363000000000001@g.us";
const g2 = "120363000000000002@g.us";
for (const c of contacts) iGP.run(g1, c[0], "member", now);
iGP.run(g1, "self", "admin", now);
iGP.run(g2, contacts[0][0], "member", now);
iGP.run(g2, contacts[1][0], "member", now);
iGP.run(g2, "self", "admin", now);
iGP.run(g2, "916666666666@s.whatsapp.net", "member", now);
iGP.run(g2, "99999999@lid", "member", now);
iGP.run(g2, "88888888@lid", "member", now);

db.close();
console.log("wrote", out);
