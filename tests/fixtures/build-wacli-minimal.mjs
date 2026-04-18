// Produces tests/fixtures/wacli-minimal.db with a deterministic, small
// dataset: 10 chats (6 DM, 2 group, 2 lid), 50 messages, 5 contacts,
// 14 group_participants rows (6 in g1 + 8 in g2).

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
     name TEXT,
     is_group INTEGER,
     last_msg_ts INTEGER
   )`,
  `CREATE TABLE messages (
     id TEXT PRIMARY KEY,
     chat_jid TEXT NOT NULL,
     sender_jid TEXT,
     direction TEXT,
     body_preview TEXT,
     ts INTEGER
   )`,
  `CREATE TABLE contacts (
     jid TEXT PRIMARY KEY,
     full_name TEXT,
     push_name TEXT,
     first_name TEXT,
     business_name TEXT,
     phone TEXT
   )`,
  `CREATE TABLE group_participants (
     group_jid TEXT NOT NULL,
     member_jid TEXT NOT NULL,
     PRIMARY KEY (group_jid, member_jid)
   )`,
];
for (const stmt of SCHEMA) db.prepare(stmt).run();

const iChat = db.prepare("INSERT INTO chats VALUES (?,?,?,?)");
const iMsg  = db.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?)");
const iCon  = db.prepare("INSERT INTO contacts VALUES (?,?,?,?,?,?)");
const iGP   = db.prepare("INSERT INTO group_participants VALUES (?,?)");

const contacts = [
  ["911111111111@s.whatsapp.net", "Alice Kumar",   null,       "Alice",  null,          "+911111111111"],
  ["912222222222@s.whatsapp.net", "Bob Singh",     "Bobby",    "Bob",    null,          "+912222222222"],
  ["913333333333@s.whatsapp.net", null,            "Charlie",  null,     null,          "+913333333333"],
  ["914444444444@s.whatsapp.net", null,            null,       null,     "Dee's Bakery","+914444444444"],
  ["915555555555@s.whatsapp.net", "Eve Thakur",    null,       "Eve",    null,          "+915555555555"],
];
for (const c of contacts) iCon.run(...c);

const chats = [
  ["911111111111@s.whatsapp.net",     "Alice Kumar",  0, 1_713_400_000],
  ["912222222222@s.whatsapp.net",     "Bobby",        0, 1_713_410_000],
  ["913333333333@s.whatsapp.net",     "Charlie",      0, 1_713_420_000],
  ["914444444444@s.whatsapp.net",     "Dee's Bakery", 0, 1_713_430_000],
  ["915555555555@s.whatsapp.net",     "Eve Thakur",   0, 1_713_440_000],
  ["916666666666@s.whatsapp.net",     null,           0, 1_713_450_000],
  ["120363000000000001@g.us",         "Team Orbit",   1, 1_713_460_000],
  ["120363000000000002@g.us",         "YC W26",       1, 1_713_470_000],
  ["99999999@lid",                    null,           0, 1_713_480_000],
  ["88888888@lid",                    null,           0, 1_713_490_000],
];
for (const c of chats) iChat.run(...c);

let msgId = 0;
const pushMsg = (chat, sender, dir, body, ts) =>
  iMsg.run(`msg-${String(++msgId).padStart(4, "0")}`, chat, sender, dir, body, ts);

for (const dmChat of chats.slice(0, 6)) {
  for (let i = 0; i < 5; i++) {
    pushMsg(dmChat[0], i % 2 === 0 ? dmChat[0] : "self",
            i % 2 === 0 ? "inbound" : "outbound",
            `hello ${i}`, dmChat[3] + i * 60);
  }
}
for (const groupChat of chats.slice(6, 8)) {
  for (let i = 0; i < 10; i++) {
    pushMsg(groupChat[0], contacts[i % 5][0], "inbound",
            `group msg ${i}`, groupChat[3] + i * 60);
  }
}

const g1 = "120363000000000001@g.us";
const g2 = "120363000000000002@g.us";
for (const c of contacts) iGP.run(g1, c[0]);
iGP.run(g1, "self");
iGP.run(g2, contacts[0][0]);
iGP.run(g2, contacts[1][0]);
iGP.run(g2, "self");
iGP.run(g2, "916666666666@s.whatsapp.net");
iGP.run(g2, "99999999@lid");
iGP.run(g2, "88888888@lid");

db.close();
console.log("wrote", out);
