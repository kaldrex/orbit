#!/usr/bin/env node
// Verification harness — Orbit Definition-of-Done scorecard.
//
// Computes 9 metrics against the live Neo4j graph and prints a pass/fail
// scorecard with current / target / floor per metric. Exits non-zero if
// any metric fails its hard floor. Writes a timestamped JSON snapshot to
// .verify-runs/ so we can track deltas across phases.
//
// Usage:
//   node scripts/verify-graph.js              Full scorecard against live
//   node scripts/verify-graph.js --json       Machine-readable JSON only
//   node scripts/verify-graph.js --replay     Bleed replay (M8), Phase 1+
//
// Env: reads NEO4J_* from .env.local (worktree root or parent).

import neo4j from "neo4j-driver";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

// Load .env.local — fall back to parent of worktree if needed.
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
  throw new Error("No .env.local found; looked in: " + candidates.join(", "));
}

const env = loadEnv();
const JSON_ONLY = process.argv.includes("--json");
const REPLAY = process.argv.includes("--replay");

const driver = neo4j.driver(
  env.NEO4J_URI,
  neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD)
);
const dbName = env.NEO4J_DATABASE || "neo4j";

async function cy(query, params = {}) {
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

// -------- Metric definitions --------

const METRICS = {
  M1: { name: "Email-duplicate clusters", target: 0, floor: 0, lowerIsBetter: true },
  M2: { name: "Ghost self-nodes", target: 0, floor: 0, lowerIsBetter: true },
  M3: { name: "Unresolved fuzzy-name clusters", target: 0, floor: 2, lowerIsBetter: true },
  M4: { name: "% persons categorized (non-other)", target: 80, floor: 70, unit: "%" },
  M5: { name: "Max score-bucket share", target: 49, floor: 54, unit: "%", lowerIsBetter: true },
  M6: { name: "% emailed persons with title", target: 70, floor: 50, unit: "%" },
  M7: { name: "% bodied interactions with topics", target: 90, floor: 75, unit: "%" },
  M8: { name: "Bleed rate (new dupes per replay)", target: 0, floor: 0, lowerIsBetter: true },
  M9: { name: "Agent use cases answerable", target: 10, floor: 8, unit: "/10" },
};

// -------- Metric computations --------

async function computeM1() {
  const rows = await cy(`
    MATCH (p:Person)
    WHERE p.email IS NOT NULL AND trim(p.email) <> ""
    WITH toLower(trim(p.email)) AS email, collect(p.id) AS ids
    WHERE size(ids) > 1
    RETURN count(email) AS clusters, collect({email: email, ids: ids})[..5] AS examples
  `);
  return { value: rows[0].clusters, examples: rows[0].examples };
}

async function computeM2() {
  // Strict: ghost's first name equals self's first name, and the first name
  // is at least 4 characters (avoids flagging a real person named "San"
  // against self="Sanchay"). Full-name substring matches are delegated to
  // Phase 3's LLM resolver, which has context to judge them.
  const rows = await cy(`
    MATCH (self:Person {category: "self"})
    WITH self, toLower(split(self.name, " ")[0]) AS selfFirst, self.userId AS uid
    WHERE size(selfFirst) >= 4
    MATCH (ghost:Person {userId: uid})
    WHERE ghost.id <> self.id
      AND ghost.category <> "self"
      AND ghost.name IS NOT NULL
      AND toLower(split(ghost.name, " ")[0]) = selfFirst
    RETURN count(ghost) AS ghosts, collect({id: ghost.id, name: ghost.name})[..5] AS examples
  `);
  return { value: rows[0].ghosts, examples: rows[0].examples };
}

async function computeM3() {
  // M3 = "unresolved identity clusters needing review".
  //
  // Counts shared-email clusters where ≥2 members have DISTINCT full last
  // names (length ≥ 3, not a paren tag, not a single-letter abbrev). Those
  // are the wrong-attribution cases (Eric Guo + Eric Bernstein + Eric Gao
  // on eric@anysphere.co; Manish Chaturvedi + Manish Patil + Manish Reddy
  // on manish@flexprice.io) that Stage A correctly refuses to auto-merge
  // and Stage B / user corrections must resolve.
  //
  // Cheap first-name collision buckets (4 different Shubhams with 4
  // different surnames) are NOT counted — those are real different people
  // sharing a first name, nothing to resolve.
  const rows = await cy(`
    MATCH (p:Person)
    WHERE p.email IS NOT NULL AND trim(p.email) <> "" AND p.category <> "self"
    WITH toLower(trim(p.email)) AS email,
         collect({id: p.id, name: p.name}) AS members
    WHERE size(members) > 1
    WITH email, members,
         [m IN members
           WHERE size(split(trim(m.name), " ")) >= 2
             AND size(last(split(trim(m.name), " "))) >= 3
             AND NOT last(split(trim(m.name), " ")) STARTS WITH "("
             AND NOT last(split(trim(m.name), " ")) ENDS WITH ")"
           | toLower(last(split(trim(m.name), " ")))
         ] AS fullLasts
    WITH email, members, fullLasts, [x IN fullLasts WHERE x IS NOT NULL] AS cleaned
    WITH email, members, apoc.coll.toSet(cleaned) AS distinctLasts
    WHERE size(distinctLasts) >= 2
    RETURN count(email) AS clusters,
           collect({email: email, distinctLasts: distinctLasts, members: members})[..5] AS examples
  `).catch(async () => {
    // Fall back without apoc.coll.toSet (plain Neo4j)
    return cy(`
      MATCH (p:Person)
      WHERE p.email IS NOT NULL AND trim(p.email) <> "" AND p.category <> "self"
      WITH toLower(trim(p.email)) AS email,
           collect({id: p.id, name: p.name}) AS members
      WHERE size(members) > 1
      WITH email, members,
           [m IN members
             WHERE size(split(trim(m.name), " ")) >= 2
               AND size(last(split(trim(m.name), " "))) >= 3
               AND NOT last(split(trim(m.name), " ")) STARTS WITH "("
               AND NOT last(split(trim(m.name), " ")) ENDS WITH ")"
             | toLower(last(split(trim(m.name), " ")))
           ] AS fullLasts
      UNWIND fullLasts AS x
      WITH email, members, collect(DISTINCT x) AS distinctLasts
      WHERE size(distinctLasts) >= 2
      RETURN count(email) AS clusters,
             collect({email: email, distinctLasts: distinctLasts, members: members})[..5] AS examples
    `);
  });
  return { value: rows[0].clusters, examples: rows[0].examples };
}

async function computeM4() {
  const rows = await cy(`
    MATCH (p:Person)
    WHERE p.category <> "self"
    WITH count(p) AS total,
         sum(CASE WHEN p.category IS NOT NULL AND p.category <> "other" THEN 1 ELSE 0 END) AS categorized
    RETURN total, categorized,
           CASE WHEN total = 0 THEN 0 ELSE toFloat(categorized) / total * 100 END AS pct
  `);
  const { total, categorized, pct } = rows[0];
  return { value: Math.round(pct * 10) / 10, extra: { total, categorized } };
}

async function computeM5() {
  // Bucket persons by relationship_score, find largest bucket's share.
  const rows = await cy(`
    MATCH (p:Person)
    WHERE p.category <> "self" AND p.relationship_score IS NOT NULL
    WITH CASE
      WHEN p.relationship_score < 1 THEN "<1"
      WHEN p.relationship_score < 2 THEN "1-2"
      WHEN p.relationship_score < 3 THEN "2-3"
      WHEN p.relationship_score < 5 THEN "3-5"
      WHEN p.relationship_score < 10 THEN "5-10"
      ELSE "10+"
    END AS bucket, count(*) AS n
    WITH collect({bucket: bucket, n: n}) AS buckets, sum(n) AS total
    UNWIND buckets AS b
    WITH buckets, total, b
    ORDER BY b.n DESC
    WITH buckets, total, head(collect(b)) AS top
    RETURN buckets, total,
           top.bucket AS topBucket, top.n AS topN,
           CASE WHEN total = 0 THEN 0 ELSE toFloat(top.n) / total * 100 END AS pct
  `);
  const { buckets, total, topBucket, topN, pct } = rows[0];
  return {
    value: Math.round(pct * 10) / 10,
    extra: { total, topBucket, topN, distribution: buckets },
  };
}

async function computeM6() {
  const rows = await cy(`
    MATCH (p:Person)
    WHERE p.category <> "self" AND p.email IS NOT NULL AND trim(p.email) <> ""
    WITH count(p) AS emailed,
         sum(CASE WHEN p.title IS NOT NULL AND trim(p.title) <> "" THEN 1 ELSE 0 END) AS titled
    RETURN emailed, titled,
           CASE WHEN emailed = 0 THEN 0 ELSE toFloat(titled) / emailed * 100 END AS pct
  `);
  const { emailed, titled, pct } = rows[0];
  return { value: Math.round(pct * 10) / 10, extra: { emailed, titled } };
}

async function computeM7() {
  // Interactions with body — here approximated by having any summary
  // populated (pre-Phase-5 proxy). Post-Phase-5 this will key off
  // raw_interactions.body presence.
  const rows = await cy(`
    MATCH ()-[r:INTERACTED]->()
    WITH count(r) AS total,
         sum(CASE WHEN r.summary IS NOT NULL AND trim(r.summary) <> "" THEN 1 ELSE 0 END) AS bodied,
         sum(CASE WHEN r.topic_summary IS NOT NULL AND trim(r.topic_summary) <> "" THEN 1 ELSE 0 END) AS topiced
    RETURN total, bodied, topiced,
           CASE WHEN bodied = 0 THEN 0 ELSE toFloat(topiced) / bodied * 100 END AS pct
  `);
  const { total, bodied, topiced, pct } = rows[0];
  return { value: Math.round(pct * 10) / 10, extra: { total, bodied, topiced } };
}

async function computeM8() {
  // Replay test — Phase 1+. Reads scripts/fixtures/bleed-test-signals.json,
  // calls the LIVE /api/v1/ingest endpoint with a synthetic userId, then counts
  // duplicates created. Until Phase 1 lands, we report "deferred".
  return { value: null, note: "Deferred — activated in Phase 1 (replay requires new matching logic)" };
}

async function computeM9() {
  // Agent use cases (from vision Part 5). This is a manual score updated as
  // tools come online. Until instrumented, we assert a conservative baseline.
  // Baseline: orbit_going_cold + orbit_network_search are partially live = 2.
  return { value: 2, note: "Baseline — hand-curated; will be auto-verified in Phase 9" };
}

// -------- Scorecard rendering --------

function judge(id, value) {
  const m = METRICS[id];
  if (value === null || value === undefined) return "⏭";
  const hitTarget = m.lowerIsBetter ? value <= m.target : value >= m.target;
  const hitFloor = m.lowerIsBetter ? value <= m.floor : value >= m.floor;
  if (hitTarget) return "✓";
  if (hitFloor) return "~";
  return "✗";
}

function fmt(value, unit) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    return unit ? `${value}${unit}` : String(value);
  }
  return String(value);
}

async function main() {
  const results = {
    M1: await computeM1(),
    M2: await computeM2(),
    M3: await computeM3(),
    M4: await computeM4(),
    M5: await computeM5(),
    M6: await computeM6(),
    M7: await computeM7(),
    M8: await computeM8(),
    M9: await computeM9(),
  };

  const summary = {};
  let anyFloorFailed = false;

  for (const [id, m] of Object.entries(METRICS)) {
    const r = results[id];
    const status = judge(id, r.value);
    if (status === "✗") anyFloorFailed = true;
    summary[id] = {
      name: m.name,
      value: r.value,
      target: m.target,
      floor: m.floor,
      unit: m.unit || "",
      status,
      ...(r.extra ? { extra: r.extra } : {}),
      ...(r.examples ? { examples: r.examples } : {}),
      ...(r.note ? { note: r.note } : {}),
    };
  }

  const snapshot = {
    timestamp: new Date().toISOString(),
    anyFloorFailed,
    metrics: summary,
  };

  // Write snapshot
  const snapDir = resolve(REPO_ROOT, ".verify-runs");
  if (!existsSync(snapDir)) mkdirSync(snapDir, { recursive: true });
  const fname = `${snapshot.timestamp.replace(/[:.]/g, "-")}.json`;
  writeFileSync(resolve(snapDir, fname), JSON.stringify(snapshot, null, 2));

  if (JSON_ONLY) {
    console.log(JSON.stringify(snapshot, null, 2));
  } else {
    console.log("");
    console.log("═".repeat(78));
    console.log("  Orbit — Definition-of-Done Scorecard");
    console.log(`  ${snapshot.timestamp}`);
    console.log("═".repeat(78));
    console.log("");
    console.log(
      "  ID   Metric                                 Current      Floor    Target  "
    );
    console.log("  ─── ──────────────────────────────────────  ──────────   ──────   ──────");
    for (const [id, s] of Object.entries(summary)) {
      const m = METRICS[id];
      const valStr = fmt(s.value, m.unit).padStart(10);
      const floorStr = fmt(m.floor, m.unit).padStart(6);
      const targetStr = fmt(m.target, m.unit).padStart(6);
      console.log(
        `  ${s.status}  ${id}  ${s.name.padEnd(36)}  ${valStr}   ${floorStr}   ${targetStr}`
      );
    }
    console.log("");
    console.log(`  Legend: ✓ meets target · ~ meets floor · ✗ below floor · ⏭ deferred`);
    console.log("");
    console.log(`  Snapshot: .verify-runs/${fname}`);
    console.log("");
    if (anyFloorFailed) {
      console.log("  ✗ At least one metric is below its hard floor.");
    } else {
      console.log("  ✓ All computable metrics meet their hard floor.");
    }
    console.log("");
  }

  await driver.close();
  process.exit(anyFloorFailed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await driver.close();
  process.exit(2);
});
