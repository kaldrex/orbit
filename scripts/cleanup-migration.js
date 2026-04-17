#!/usr/bin/env node
// One-time migration to clean up Neo4j data quality issues.
//
// Operations (in order):
//   1. Normalize non-standard categories to valid ones
//   2. Delete orphan nodes (zero INTERACTED + KNOWS edges)
//   3. Merge duplicate persons (same name, case-insensitive)
//   4. Delete false KNOWS edges (null context + no INTERACTED between pair)
//
// Run: node scripts/cleanup-migration.js [--dry-run] [--user <userId>]
// Default: applies to all users in the graph.

import neo4j from "neo4j-driver";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env.local
const envPath = resolve(__dirname, "..", ".env.local");
const env = Object.fromEntries(
  readFileSync(envPath, "utf-8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const idx = l.indexOf("=");
      return [l.slice(0, idx), l.slice(idx + 1)];
    })
);

const DRY_RUN = process.argv.includes("--dry-run");
const USER_FILTER_IDX = process.argv.indexOf("--user");
const USER_FILTER = USER_FILTER_IDX !== -1 ? process.argv[USER_FILTER_IDX + 1] : null;

const driver = neo4j.driver(
  env.NEO4J_URI.trim(),
  neo4j.auth.basic(env.NEO4J_USER.trim(), env.NEO4J_PASSWORD.trim()),
);
const dbName = (env.NEO4J_DATABASE || "neo4j").trim();

const log = (...args) => console.log(DRY_RUN ? "[DRY RUN]" : "[LIVE]", ...args);

async function run(cypher, params = {}) {
  const s = driver.session({ database: dbName });
  try {
    const result = await s.run(cypher, params);
    return result.records;
  } finally {
    await s.close();
  }
}

async function main() {
  log("=".repeat(60));
  log("Orbit Neo4j Cleanup Migration");
  log("=".repeat(60));
  if (DRY_RUN) log("DRY RUN MODE — no writes will be performed");
  if (USER_FILTER) log(`Filtering to user: ${USER_FILTER}`);

  async function counts() {
    const p = await run(`MATCH (p:Person) ${USER_FILTER ? "WHERE p.userId = $userId" : ""} RETURN count(p) as c`, USER_FILTER ? { userId: USER_FILTER } : {});
    const i = await run(`MATCH ()-[r:INTERACTED]->() ${USER_FILTER ? "WHERE startNode(r).userId = $userId OR endNode(r).userId = $userId" : ""} RETURN count(r) as c`, USER_FILTER ? { userId: USER_FILTER } : {});
    const k = await run(`MATCH ()-[r:KNOWS]->() ${USER_FILTER ? "WHERE startNode(r).userId = $userId OR endNode(r).userId = $userId" : ""} RETURN count(r) as c`, USER_FILTER ? { userId: USER_FILTER } : {});
    return { persons: p[0].get("c").toNumber(), interacted: i[0].get("c").toNumber(), knows: k[0].get("c").toNumber() };
  }
  const before = await counts();
  log(`\nBefore: ${before.persons} persons, ${before.interacted} INTERACTED, ${before.knows} KNOWS`);

  // === Step 1: Normalize categories ===
  log("\n--- Step 1: Normalize non-standard categories ---");
  const nonStandard = await run(
    `MATCH (p:Person) WHERE NOT p.category IN ['self','team','investor','sponsor','fellow','media','community','gov','founder','friend','press','other']
     ${USER_FILTER ? "AND p.userId = $userId" : ""}
     RETURN p.category as cat, count(p) as cnt ORDER BY cnt DESC`,
    USER_FILTER ? { userId: USER_FILTER } : {}
  );
  log(`Found ${nonStandard.length} non-standard category values:`);
  nonStandard.forEach((r) => {
    const o = r.toObject();
    log(`  ${o.cat}: ${o.cnt.toNumber()}`);
  });

  if (!DRY_RUN && nonStandard.length > 0) {
    // Map: whatsapp*, contact, calendar-meeting -> other | network, professional -> fellow
    await run(
      `MATCH (p:Person) WHERE p.category IN ['whatsapp','whatsapp_contact','WhatsApp-India','contact','calendar-meeting']
       ${USER_FILTER ? "AND p.userId = $userId" : ""}
       SET p.category = 'other'`,
      USER_FILTER ? { userId: USER_FILTER } : {}
    );
    await run(
      `MATCH (p:Person) WHERE p.category IN ['network','professional']
       ${USER_FILTER ? "AND p.userId = $userId" : ""}
       SET p.category = 'fellow'`,
      USER_FILTER ? { userId: USER_FILTER } : {}
    );
    // Anything else -> other
    await run(
      `MATCH (p:Person) WHERE NOT p.category IN ['self','team','investor','sponsor','fellow','media','community','gov','founder','friend','press','other']
       ${USER_FILTER ? "AND p.userId = $userId" : ""}
       SET p.category = 'other'`,
      USER_FILTER ? { userId: USER_FILTER } : {}
    );
    log("✓ Categories normalized");
  }

  // === Step 2: Delete orphan nodes ===
  log("\n--- Step 2: Delete orphan nodes (zero connections) ---");
  const orphans = await run(
    `MATCH (p:Person) WHERE p.category <> 'self'
     ${USER_FILTER ? "AND p.userId = $userId" : ""}
     AND NOT (p)-[:INTERACTED]-() AND NOT (p)-[:KNOWS]-()
     RETURN p.id as id, p.name as name, p.category as cat`,
    USER_FILTER ? { userId: USER_FILTER } : {}
  );
  log(`Found ${orphans.length} orphan nodes`);
  orphans.slice(0, 10).forEach((r) => {
    const o = r.toObject();
    log(`  ${o.name} (${o.cat}) — ${o.id}`);
  });
  if (orphans.length > 10) log(`  ... and ${orphans.length - 10} more`);

  if (!DRY_RUN && orphans.length > 0) {
    await run(
      `MATCH (p:Person) WHERE p.category <> 'self'
       ${USER_FILTER ? "AND p.userId = $userId" : ""}
       AND NOT (p)-[:INTERACTED]-() AND NOT (p)-[:KNOWS]-()
       DELETE p`,
      USER_FILTER ? { userId: USER_FILTER } : {}
    );
    log(`✓ Deleted ${orphans.length} orphan nodes`);
  }

  // === Step 3: Merge duplicate persons ===
  log("\n--- Step 3: Merge duplicate persons (same lowercased name) ---");
  const dupes = await run(
    `MATCH (p:Person) WHERE p.category <> 'self'
     ${USER_FILTER ? "AND p.userId = $userId" : ""}
     WITH toLower(p.name) as lname, p.userId as uid, collect(p) as nodes
     WHERE size(nodes) > 1
     RETURN lname, uid, [n IN nodes | {id: n.id, name: n.name, email: n.email, company: n.company}] as dupes`,
    USER_FILTER ? { userId: USER_FILTER } : {}
  );
  log(`Found ${dupes.length} duplicate clusters`);
  dupes.slice(0, 10).forEach((r) => {
    const o = r.toObject();
    log(`  "${o.lname}" — ${o.dupes.length} variants`);
  });

  if (!DRY_RUN && dupes.length > 0) {
    let mergeCount = 0;
    for (const record of dupes) {
      const { uid, dupes: nodes } = record.toObject();
      // Pick survivor: most edges, tiebreak by has email
      const nodeIds = nodes.map((n) => n.id);

      // Count edges per node
      const edgeCounts = await run(
        `UNWIND $ids as id
         MATCH (p:Person {id: id, userId: $uid})
         OPTIONAL MATCH (p)-[i:INTERACTED]-()
         OPTIONAL MATCH (p)-[k:KNOWS]-()
         WITH p, count(DISTINCT i) + count(DISTINCT k) as total
         RETURN p.id as id, total`,
        { ids: nodeIds, uid }
      );
      const counts = new Map(
        edgeCounts.map((r) => {
          const o = r.toObject();
          return [o.id, o.total.toNumber()];
        })
      );

      const sorted = [...nodes].sort((a, b) => {
        const countDiff = (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0);
        if (countDiff !== 0) return countDiff;
        if (a.email && !b.email) return -1;
        if (!a.email && b.email) return 1;
        return 0;
      });
      const survivor = sorted[0];
      const losers = sorted.slice(1);

      for (const loser of losers) {
        // Re-point INTERACTED edges
        await run(
          `MATCH (loser:Person {id: $loserId, userId: $uid})-[r:INTERACTED]-(other)
           MATCH (survivor:Person {id: $survivorId, userId: $uid})
           CREATE (survivor)-[:INTERACTED {
             channel: r.channel, timestamp: r.timestamp, summary: r.summary,
             topic_summary: r.topic_summary, relationship_context: r.relationship_context,
             sentiment: r.sentiment
           }]->(other)
           DELETE r`,
          { loserId: loser.id, survivorId: survivor.id, uid }
        );
        await run(
          `MATCH (other)-[r:INTERACTED]->(loser:Person {id: $loserId, userId: $uid})
           MATCH (survivor:Person {id: $survivorId, userId: $uid})
           CREATE (other)-[:INTERACTED {
             channel: r.channel, timestamp: r.timestamp, summary: r.summary,
             topic_summary: r.topic_summary, relationship_context: r.relationship_context,
             sentiment: r.sentiment
           }]->(survivor)
           DELETE r`,
          { loserId: loser.id, survivorId: survivor.id, uid }
        );

        // Re-point KNOWS edges
        await run(
          `MATCH (loser:Person {id: $loserId, userId: $uid})-[r:KNOWS]-(other)
           MATCH (survivor:Person {id: $survivorId, userId: $uid})
           MERGE (survivor)-[newR:KNOWS]->(other)
             ON CREATE SET newR.source = r.source, newR.context = r.context, newR.created_at = r.created_at
           DELETE r`,
          { loserId: loser.id, survivorId: survivor.id, uid }
        );

        // Copy metadata if survivor is missing
        if (loser.email && !survivor.email) {
          await run(
            `MATCH (s:Person {id: $id, userId: $uid}) SET s.email = $email`,
            { id: survivor.id, uid, email: loser.email }
          );
        }
        if (loser.company && !survivor.company) {
          await run(
            `MATCH (s:Person {id: $id, userId: $uid}) SET s.company = $company`,
            { id: survivor.id, uid, company: loser.company }
          );
        }

        // Delete the loser
        await run(
          `MATCH (p:Person {id: $id, userId: $uid}) DELETE p`,
          { id: loser.id, uid }
        );
        mergeCount++;
      }
    }
    log(`✓ Merged ${mergeCount} duplicate nodes into survivors`);
  }

  // === Step 4: Delete false KNOWS edges ===
  log("\n--- Step 4: Delete false KNOWS edges (no real evidence) ---");
  const falseKnows = await run(
    `MATCH (a:Person)-[k:KNOWS]->(b:Person)
     WHERE (k.context IS NULL OR k.context = '')
       AND NOT (a)-[:INTERACTED]-(b)
       AND a.category <> 'self' AND b.category <> 'self'
       ${USER_FILTER ? "AND a.userId = $userId" : ""}
     RETURN count(k) as cnt`,
    USER_FILTER ? { userId: USER_FILTER } : {}
  );
  const falseCount = falseKnows[0].toObject().cnt.toNumber();
  log(`Found ${falseCount} false KNOWS edges`);

  if (!DRY_RUN && falseCount > 0) {
    await run(
      `MATCH (a:Person)-[k:KNOWS]->(b:Person)
       WHERE (k.context IS NULL OR k.context = '')
         AND NOT (a)-[:INTERACTED]-(b)
         AND a.category <> 'self' AND b.category <> 'self'
         ${USER_FILTER ? "AND a.userId = $userId" : ""}
       DELETE k`,
      USER_FILTER ? { userId: USER_FILTER } : {}
    );
    log(`✓ Deleted ${falseCount} false KNOWS edges`);
  }

  // === Final counts ===
  const after = await counts();
  log(`\n${"=".repeat(60)}`);
  log("Results:");
  log(`  Persons:       ${before.persons} → ${after.persons} (−${before.persons - after.persons})`);
  log(`  INTERACTED:    ${before.interacted} → ${after.interacted} (−${before.interacted - after.interacted})`);
  log(`  KNOWS:         ${before.knows} → ${after.knows} (−${before.knows - after.knows})`);

  await driver.close();
}

main().catch((err) => {
  console.error("[ERROR]", err);
  process.exit(1);
});
