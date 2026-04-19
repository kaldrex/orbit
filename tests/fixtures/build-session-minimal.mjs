// Rebuilds tests/fixtures/session-minimal.db — a minimal SQLite with
// just the whatsmeow_lid_map table + a few known rows. Used by the
// orbit-rules plugin's lid_to_phone tests.
//
// Run: node tests/fixtures/build-session-minimal.mjs

import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "session-minimal.db");
if (fs.existsSync(out)) fs.unlinkSync(out);
if (fs.existsSync(out + "-wal")) fs.unlinkSync(out + "-wal");
if (fs.existsSync(out + "-shm")) fs.unlinkSync(out + "-shm");

const db = new Database(out);
db.prepare(
  "CREATE TABLE whatsmeow_lid_map (lid TEXT PRIMARY KEY, pn TEXT UNIQUE NOT NULL)",
).run();
const ins = db.prepare("INSERT INTO whatsmeow_lid_map (lid, pn) VALUES (?, ?)");
const rows = [
  ["207283862659127", "971586783040"], // Umayr
  ["100000000000001", "919136820958"], // Sanchay
  ["100000000000002", "919999999999"], // some test contact
];
for (const [lid, pn] of rows) ins.run(lid, pn);
db.close();
console.log(`wrote ${out} (${rows.length} rows)`);
