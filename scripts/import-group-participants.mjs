// Reads group_participants from a wacli SQLite DB and MERGEs
// CO_PRESENT_IN edges in Neo4j. Weight is always 0.1 regardless of
// group size — this is a weak signal, not a relationship-activity proxy.
//
// The function is pure over its `runCypher` dep so integration tests can
// swap in a fake. Run directly (no args) to perform a live import using
// $WACLI_DB (default ~/.wacli/wacli.db) and the NEO4J_* env vars.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CYPHER = readFileSync(
  resolve(__dirname, "..", "src", "lib", "cypher", "co-present-edge.cypher"),
  "utf8",
);

export async function importGroupParticipants({ db, runCypher, resolvePerson }) {
  resolvePerson = resolvePerson || ((jid) => jid);

  // wacli real schema uses `user_jid`; we kept a fallback for older
  // fixtures that used `member_jid`.
  const colInfo = db.prepare("PRAGMA table_info(group_participants)").all();
  const col = colInfo.some((c) => c.name === "user_jid")
    ? "user_jid"
    : "member_jid";

  const rows = db
    .prepare(`SELECT group_jid, ${col} AS member_jid FROM group_participants ORDER BY group_jid`)
    .all();

  const groups = new Map();
  for (const { group_jid, member_jid } of rows) {
    const pid = resolvePerson(member_jid);
    if (!pid) continue;
    if (!groups.has(group_jid)) groups.set(group_jid, new Set());
    groups.get(group_jid).add(pid);
  }

  let processed = 0;
  for (const [groupJid, members] of groups) {
    if (members.size < 2) continue;
    await runCypher(CYPHER, {
      groupJid,
      memberIds: [...members].sort(),
    });
    processed += 1;
  }
  return { groups_processed: processed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const Database = (await import("better-sqlite3")).default;
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const wacliPath =
    process.env.WACLI_DB || join(homedir(), ".wacli", "wacli.db");
  const db = new Database(wacliPath, { readonly: true });

  const neo4j = (await import("neo4j-driver")).default;
  const driver = neo4j.driver(
    process.env.NEO4J_URI,
    neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD),
  );
  const session = driver.session({
    database: process.env.NEO4J_DATABASE || "neo4j",
  });
  const runCypher = async (cypher, params) =>
    (await session.run(cypher, params)).records;

  const result = await importGroupParticipants({ db, runCypher });
  console.log(JSON.stringify(result));
  await session.close();
  await driver.close();
  db.close();
}
