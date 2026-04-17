#!/usr/bin/env node
// Standalone rules-engine exerciser.
//
// Pulls all Person nodes directly from Neo4j (skipping the HTTP API), runs
// the CanonicalNameResolver (Stage A), prints the clusters it would merge.
// Read-only — does not touch the graph. Safe to run any time.
//
// Usage: node scripts/test-resolver.js [--apply]
//   --apply runs the full Stage A merge loop against the live graph via
//   a direct Cypher migration (skips the HTTP API so it can run before
//   the Vercel deploy completes).

import neo4j from "neo4j-driver";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CanonicalNameResolver } from "../packages/orbit-plugin/lib/identity-resolver-rules.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const APPLY = process.argv.includes("--apply");

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
  throw new Error("No .env.local");
}

const env = loadEnv();
const driver = neo4j.driver(
  env.NEO4J_URI,
  neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD)
);
const dbName = env.NEO4J_DATABASE || "neo4j";

async function cy(q, params = {}) {
  const s = driver.session({ database: dbName, defaultAccessMode: neo4j.session.WRITE });
  try {
    const r = await s.run(q, params);
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

async function applyMerge(userId, canonicalId, mergeIds) {
  // Mirrors src/app/api/v1/merge/route.ts logic — direct Cypher version so
  // we don't need the Vercel deploy to run Stage A.
  const s = driver.session({ database: dbName, defaultAccessMode: neo4j.session.WRITE });
  const tx = s.beginTransaction();
  try {
    // 1. Re-point INTERACTED edges (target side)
    await tx.run(
      `MATCH (a:Person {userId: $userId})-[r:INTERACTED]->(m:Person {userId: $userId})
       WHERE m.id IN $mergeIds
       MATCH (canonical:Person {id: $canonicalId, userId: $userId})
       WHERE NOT EXISTS {
         MATCH (a)-[r2:INTERACTED]->(canonical)
         WHERE r2.channel = r.channel AND r2.timestamp = r.timestamp
       }
       CREATE (a)-[:INTERACTED {
         channel: r.channel, timestamp: r.timestamp,
         summary: r.summary, topic_summary: r.topic_summary,
         relationship_context: r.relationship_context, sentiment: r.sentiment
       }]->(canonical)`,
      { userId, mergeIds, canonicalId }
    );
    // 2. KNOWS outgoing
    await tx.run(
      `MATCH (m:Person {userId: $userId})-[k:KNOWS]->(other:Person {userId: $userId})
       WHERE m.id IN $mergeIds AND other.id <> $canonicalId AND NOT other.id IN $mergeIds
       MATCH (canonical:Person {id: $canonicalId, userId: $userId})
       MERGE (canonical)-[new:KNOWS]->(other)
       ON CREATE SET new.source = k.source, new.context = k.context, new.created_at = datetime()`,
      { userId, mergeIds, canonicalId }
    );
    // 3. KNOWS incoming
    await tx.run(
      `MATCH (other:Person {userId: $userId})-[k:KNOWS]->(m:Person {userId: $userId})
       WHERE m.id IN $mergeIds AND other.id <> $canonicalId AND NOT other.id IN $mergeIds
       MATCH (canonical:Person {id: $canonicalId, userId: $userId})
       MERGE (other)-[new:KNOWS]->(canonical)
       ON CREATE SET new.source = k.source, new.context = k.context, new.created_at = datetime()`,
      { userId, mergeIds, canonicalId }
    );
    // 4. Union metadata
    await tx.run(
      `MATCH (canonical:Person {id: $canonicalId, userId: $userId})
       MATCH (m:Person {userId: $userId}) WHERE m.id IN $mergeIds
       WITH canonical, collect(m) AS merged
       WITH canonical,
            [x IN merged WHERE x.email IS NOT NULL | x.email] AS emails,
            [x IN merged WHERE x.phone IS NOT NULL | x.phone] AS phones,
            [x IN merged WHERE x.company IS NOT NULL | x.company] AS companies,
            [x IN merged WHERE x.title IS NOT NULL | x.title] AS titles,
            [x IN merged WHERE x.category IS NOT NULL AND x.category <> "other" | x.category] AS cats,
            [x IN merged | x.relationship_score] AS scores,
            [x IN merged WHERE x.name IS NOT NULL | x.name] AS altNames
       SET canonical.email = COALESCE(canonical.email, head(emails)),
           canonical.phone = COALESCE(canonical.phone, head(phones)),
           canonical.company = COALESCE(canonical.company, head(companies)),
           canonical.title = COALESCE(canonical.title, head(titles)),
           canonical.category = CASE WHEN canonical.category = "other" AND size(cats) > 0 THEN head(cats) ELSE canonical.category END,
           canonical.relationship_score = CASE
             WHEN canonical.relationship_score IS NULL THEN reduce(m = 0.0, v IN scores | CASE WHEN v > m THEN v ELSE m END)
             ELSE reduce(m = canonical.relationship_score, v IN scores | CASE WHEN v > m THEN v ELSE m END)
           END,
           canonical.aliases = CASE
             WHEN canonical.aliases IS NULL THEN [x IN altNames WHERE toLower(x) <> toLower(canonical.name)]
             ELSE canonical.aliases + [x IN altNames WHERE toLower(x) <> toLower(canonical.name) AND NOT x IN canonical.aliases]
           END`,
      { userId, mergeIds, canonicalId }
    );
    // 5. Delete merged
    await tx.run(
      `MATCH (m:Person {userId: $userId}) WHERE m.id IN $mergeIds DETACH DELETE m`,
      { userId, mergeIds }
    );
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  } finally {
    await s.close();
  }
}

async function main() {
  // Resolve the one active userId (multi-tenant-ready, but prod has one user)
  const users = await cy(
    `MATCH (p:Person {category: "self"}) RETURN p.userId AS uid, p.id AS selfId`
  );
  if (users.length !== 1) {
    throw new Error(`Expected 1 self node, got ${users.length}`);
  }
  const userId = users[0].uid;
  console.log(`userId: ${userId}`);

  // Include self so the resolver can propose ghost-self merges universally
  const persons = await cy(
    `MATCH (p:Person {userId: $userId})
     RETURN p.id AS id, p.name AS name, p.email AS email, p.phone AS phone,
            p.category AS category, p.aliases AS aliases`,
    { userId }
  );
  console.log(`persons (incl. self): ${persons.length}`);

  const resolver = new CanonicalNameResolver();
  for (const p of persons) {
    resolver.add({
      id: p.id,
      name: p.name,
      email: p.email,
      phone: p.phone,
      isSelf: p.category === "self",
      aliases: p.aliases || null,
    });
  }
  const clusters = resolver.resolve();

  const certain = clusters.filter((c) => c.certainty === "certain");
  const ambiguous = clusters.filter((c) => c.certainty === "ambiguous");

  console.log("");
  console.log(`clusters: ${clusters.length}  (certain: ${certain.length}, ambiguous: ${ambiguous.length})`);
  console.log("");
  console.log("─── CERTAIN (safe to auto-merge) ───");
  for (const c of certain.slice(0, 30)) {
    console.log(`  canonical=${c.canonical}`);
    console.log(`    names    : ${c.names.join(" | ")}`);
    console.log(`    merging  : ${c.members.length} ids`);
    console.log(`    reasoning: ${c.reasoning}`);
    console.log("");
  }
  if (certain.length > 30) console.log(`  … and ${certain.length - 30} more certain`);

  console.log("");
  console.log("─── AMBIGUOUS (defer to Stage B / user review) ───");
  for (const c of ambiguous.slice(0, 20)) {
    console.log(`  canonical=${c.canonical}`);
    console.log(`    names    : ${c.names.join(" | ")}`);
    console.log(`    reasoning: ${c.reasoning}`);
    console.log("");
  }
  if (ambiguous.length > 20) console.log(`  … and ${ambiguous.length - 20} more ambiguous`);

  if (!APPLY) {
    console.log("");
    console.log("(dry-run — re-run with --apply to execute CERTAIN merges only)");
    await driver.close();
    return;
  }

  console.log("");
  console.log(`Applying ${certain.length} certain merges (ambiguous stay untouched)...`);
  let ok = 0;
  let failed = 0;
  for (const c of certain) {
    try {
      await applyMerge(userId, c.canonical, c.members);
      ok++;
    } catch (err) {
      failed++;
      console.error(`  FAILED ${c.canonical}: ${err.message}`);
    }
  }
  console.log(`Applied ${ok} / ${certain.length} certain (${failed} failed)`);

  await driver.close();
}

main().catch(async (err) => {
  console.error(err);
  await driver.close();
  process.exit(1);
});
