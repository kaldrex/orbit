#!/usr/bin/env node
// Phase 2 migration — self-dedup.
//
// The live graph has 3 Persons whose name matches the user ("Sanchay"):
//   - user_728032c5 — the canonical self node, category="self"
//   - p_8a9fbefc    — ghost "Sanchay",           category="other"
//   - p_032f60cf    — ghost "Sanchay Thalnerkar", category="other"
//
// The ghosts were created before Phase 1 landed because WhatsApp group
// messages where Sanchay was the sender (contactName="Sanchay") hit the
// name-only matching cascade and got routed into new "other" Person nodes
// instead of the self node. Every group message Sanchay sent inflated the
// ghost's edge count. Result: 274 + 18 phantom INTERACTED edges and 49
// phantom KNOWS edges.
//
// Strategy:
//   For each ghost:
//     1. If the ghost has email/phone/alias info the self node lacks, copy it.
//     2. Drop the INTERACTED edges from self → ghost. They represent
//        self-to-self noise; merging them into self would create self-loops
//        of no semantic value.
//     3. Drop the KNOWS edges attached to the ghost. These mean "Sanchay
//        (ghost) and X co-appeared in a convo" which is already captured by
//        self -[:INTERACTED]-> X; self doesn't have KNOWS edges as a
//        convention in this schema.
//     4. DETACH DELETE the ghost.
//
// Runs inside a single write transaction. Emits a before/after manifest to
// scripts/migrations/.applied/ so we have an audit trail.
//
// Usage:
//   node scripts/migrations/001-self-dedup.js            # dry-run
//   node scripts/migrations/001-self-dedup.js --apply    # live

import neo4j from "neo4j-driver";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const APPLIED_DIR = resolve(__dirname, ".applied");

const APPLY = process.argv.includes("--apply");

const SELF_ID = "user_728032c5";
const GHOST_IDS = ["p_8a9fbefc", "p_032f60cf"];
const USER_ID = "8aa06ce2-6d45-4df2-9d85-3fa0ad1d7c14"; // Sanchay's Supabase user id
// If the canonical user id isn't known, we derive it from the self node below.

function loadEnv() {
  const candidates = [
    resolve(REPO_ROOT, ".env.local"),
    resolve(REPO_ROOT, "..", "..", "..", ".env.local"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return Object.fromEntries(
        readFileSync(p, "utf-8")
          .split("\n")
          .filter((l) => l && !l.startsWith("#"))
          .map((l) => {
            const i = l.indexOf("=");
            return [l.slice(0, i), l.slice(i + 1).trim()];
          })
      );
    }
  }
  throw new Error("No .env.local found");
}

const env = loadEnv();
const driver = neo4j.driver(
  env.NEO4J_URI,
  neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD)
);
const dbName = env.NEO4J_DATABASE || "neo4j";
const tag = APPLY ? "[APPLY]" : "[DRY-RUN]";
const log = (...a) => console.log(tag, ...a);

async function read(query, params = {}) {
  const s = driver.session({ database: dbName });
  try {
    const r = await s.run(query, params);
    return r.records.map((rec) => {
      const o = {};
      for (const k of rec.keys) {
        const v = rec.get(k);
        o[k] = neo4j.isInt(v) ? v.toNumber() : v;
      }
      return o;
    });
  } finally {
    await s.close();
  }
}

async function main() {
  log("Self-dedup migration");
  log("  SELF_ID:", SELF_ID);
  log("  GHOST_IDS:", GHOST_IDS.join(", "));

  // Resolve the actual userId from the self node (don't trust the hardcode above)
  const selfNode = await read(
    `MATCH (p:Person {id: $selfId}) RETURN p.userId AS userId, p.name AS name, p.email AS email, p.phone AS phone, p.category AS category`,
    { selfId: SELF_ID }
  );
  if (selfNode.length === 0) {
    throw new Error(`Self node ${SELF_ID} not found`);
  }
  const actualUserId = selfNode[0].userId;
  log("  resolved userId:", actualUserId);
  log("  self name:", selfNode[0].name);
  log("  self email:", selfNode[0].email || "(none)");

  // Inventory the ghost nodes
  const ghosts = await read(
    `MATCH (g:Person) WHERE g.id IN $ghostIds RETURN g.id AS id, g.name AS name,
            g.email AS email, g.phone AS phone, g.category AS category,
            g.userId AS userId`,
    { ghostIds: GHOST_IDS }
  );
  log("  ghost nodes found:", ghosts.length);
  for (const g of ghosts) {
    log(`   - ${g.id}: name="${g.name}" email=${g.email || "—"} phone=${g.phone || "—"} category=${g.category} userId=${g.userId}`);
  }

  if (ghosts.length === 0) {
    log("No ghost nodes — nothing to do.");
    await driver.close();
    return;
  }

  // Sanity: ghosts must be in the same tenant as self
  for (const g of ghosts) {
    if (g.userId !== actualUserId) {
      throw new Error(
        `Ghost ${g.id} has userId=${g.userId}, expected ${actualUserId}; refusing to touch cross-tenant data`
      );
    }
  }

  // Inventory edges
  const edgeStats = await read(
    `MATCH (g:Person) WHERE g.id IN $ghostIds
     OPTIONAL MATCH (self:Person {id: $selfId})-[rin:INTERACTED]->(g)
     OPTIONAL MATCH (g)-[rout:INTERACTED]->(x:Person)
     OPTIONAL MATCH (g)-[kout:KNOWS]->(y:Person)
     OPTIONAL MATCH (z:Person)-[kin:KNOWS]->(g)
     RETURN g.id AS id,
            count(DISTINCT rin) AS interactedFromSelf,
            count(DISTINCT rout) AS interactedFromGhost,
            count(DISTINCT kout) AS knowsOutgoing,
            count(DISTINCT kin) AS knowsIncoming`,
    { selfId: SELF_ID, ghostIds: GHOST_IDS }
  );

  log("Edge inventory:");
  for (const e of edgeStats) {
    log(
      `  ${e.id}: self→ghost INTERACTED=${e.interactedFromSelf}, ghost→? INTERACTED=${e.interactedFromGhost}, KNOWS out=${e.knowsOutgoing} in=${e.knowsIncoming}`
    );
  }

  const totalEdges = edgeStats.reduce(
    (acc, e) =>
      acc +
      e.interactedFromSelf +
      e.interactedFromGhost +
      e.knowsOutgoing +
      e.knowsIncoming,
    0
  );
  log(`Total edges to drop: ${totalEdges}`);

  // Opportunistically copy email/phone to self if ghosts carry any self lacks
  const ghostEmails = ghosts.map((g) => g.email).filter(Boolean);
  const ghostPhones = ghosts.map((g) => g.phone).filter(Boolean);
  if (!selfNode[0].email && ghostEmails.length > 0) {
    log(`Will copy email to self: ${ghostEmails[0]}`);
  }
  if (!selfNode[0].phone && ghostPhones.length > 0) {
    log(`Will copy phone to self: ${ghostPhones[0]}`);
  }

  const manifest = {
    timestamp: new Date().toISOString(),
    migration: "001-self-dedup",
    mode: APPLY ? "apply" : "dry-run",
    selfId: SELF_ID,
    selfName: selfNode[0].name,
    userId: actualUserId,
    ghosts,
    edgeStats,
    emailCopied: !selfNode[0].email && ghostEmails.length > 0 ? ghostEmails[0] : null,
    phoneCopied: !selfNode[0].phone && ghostPhones.length > 0 ? ghostPhones[0] : null,
  };

  if (!APPLY) {
    log("");
    log("Dry-run complete. Re-run with --apply to execute.");
    await driver.close();
    return;
  }

  // Apply in a single transaction
  log("");
  log("Applying...");
  const s = driver.session({
    database: dbName,
    defaultAccessMode: neo4j.session.WRITE,
  });
  try {
    const tx = s.beginTransaction();
    try {
      // 1. Copy email/phone to self if missing
      await tx.run(
        `MATCH (self:Person {id: $selfId})
         WHERE self.email IS NULL OR self.phone IS NULL
         WITH self
         MATCH (g:Person) WHERE g.id IN $ghostIds
         WITH self, collect(g) AS ghosts
         WITH self,
              [x IN ghosts WHERE x.email IS NOT NULL | x.email] AS emails,
              [x IN ghosts WHERE x.phone IS NOT NULL | x.phone] AS phones
         SET self.email = COALESCE(self.email, head(emails)),
             self.phone = COALESCE(self.phone, head(phones))`,
        { selfId: SELF_ID, ghostIds: GHOST_IDS }
      );

      // 2. DETACH DELETE the ghosts (this removes all attached edges too)
      const delResult = await tx.run(
        `MATCH (g:Person) WHERE g.id IN $ghostIds
         DETACH DELETE g
         RETURN count(g) AS deleted`,
        { ghostIds: GHOST_IDS }
      );
      manifest.deletedNodes = delResult.records[0].get("deleted").toNumber();

      await tx.commit();
      log(`  deleted ${manifest.deletedNodes} ghost nodes (with ${totalEdges} attached edges)`);
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  } finally {
    await s.close();
  }

  // Write audit manifest
  if (!existsSync(APPLIED_DIR)) mkdirSync(APPLIED_DIR, { recursive: true });
  const fname = `001-self-dedup-${manifest.timestamp.replace(/[:.]/g, "-")}.json`;
  writeFileSync(resolve(APPLIED_DIR, fname), JSON.stringify(manifest, null, 2));
  log(`Audit: scripts/migrations/.applied/${fname}`);

  await driver.close();
}

main().catch(async (err) => {
  console.error(err);
  await driver.close();
  process.exit(1);
});
