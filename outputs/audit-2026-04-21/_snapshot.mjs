#!/usr/bin/env node
// Snapshot Orbit state: Postgres (observations + persons derived), Neo4j (Persons + edges).
// Usage: node _snapshot.mjs <label>
//   <label> = "before" | "after"

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import neo4j from "neo4j-driver";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const label = process.argv[2] || "before";

const envText = readFileSync(path.resolve(__dirname, "../../.env.local"), "utf8");
const env = Object.fromEntries(
  envText
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const MEET_PID_PREFIX = "24e45dc3";

const pgClient = new pg.Client({ connectionString: env.SUPABASE_DB_URL });
await pgClient.connect();

const driver = neo4j.driver(env.NEO4J_URI, neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD));

const out = { label, t: new Date().toISOString() };

// --- Postgres aggregates ---
const obsByKind = await pgClient.query(
  "SELECT kind, count(*)::int AS c FROM observations GROUP BY 1 ORDER BY 1"
);
out.observations_by_kind = Object.fromEntries(obsByKind.rows.map((r) => [r.kind, r.c]));
out.observations_total = Object.values(out.observations_by_kind).reduce((a, b) => a + b, 0);

const personsCount = await pgClient.query("SELECT count(*)::int AS c FROM persons");
out.persons_total = personsCount.rows[0].c;

const linksCount = await pgClient.query("SELECT count(*)::int AS c FROM person_observation_links");
out.person_observation_links_total = linksCount.rows[0].c;

const topicsCount = await pgClient.query("SELECT count(*)::int AS c FROM person_topics");
out.person_topics_total = topicsCount.rows[0].c;

// Category distribution from latest kind='person' observation linked to each person
const catDist = await pgClient.query(`
  WITH latest_person_obs AS (
    SELECT DISTINCT ON (pol.person_id)
      pol.person_id,
      o.payload
    FROM person_observation_links pol
    JOIN observations o ON o.id = pol.observation_id
    WHERE o.kind = 'person'
    ORDER BY pol.person_id, o.observed_at DESC NULLS LAST, o.ingested_at DESC NULLS LAST
  )
  SELECT
    COALESCE(payload->>'category', '__none__') AS category,
    count(*)::int AS c
  FROM latest_person_obs
  GROUP BY 1
  ORDER BY c DESC
`);
out.category_distribution = Object.fromEntries(catDist.rows.map((r) => [r.category, r.c]));

// Persons with NO kind='person' observation linked
const personsNoObs = await pgClient.query(`
  SELECT count(*)::int AS c FROM persons p
  WHERE NOT EXISTS (
    SELECT 1 FROM person_observation_links pol
    JOIN observations o ON o.id = pol.observation_id
    WHERE pol.person_id = p.id AND o.kind = 'person'
  )
`);
out.persons_without_person_obs = personsNoObs.rows[0].c;

// --- Neo4j ---
const session = driver.session({ database: env.NEO4J_DATABASE });
try {
  const r1 = await session.run("MATCH (p:Person) RETURN count(p) AS c");
  out.neo4j_person_count = r1.records[0].get("c").toNumber();

  const r2 = await session.run(`
    MATCH ()-[r]->()
    RETURN type(r) AS type, count(r) AS c
    ORDER BY type
  `);
  out.neo4j_edges_by_type = Object.fromEntries(
    r2.records.map((rec) => [rec.get("type"), rec.get("c").toNumber()])
  );
} finally {
  await session.close();
}

// --- Samples ---
// Umayr: latest person-observation for anyone whose name contains Umayr
const umayr = await pgClient.query(`
  WITH latest AS (
    SELECT DISTINCT ON (pol.person_id)
      pol.person_id,
      o.id AS observation_id,
      o.observed_at,
      o.payload
    FROM person_observation_links pol
    JOIN observations o ON o.id = pol.observation_id
    WHERE o.kind = 'person'
      AND (o.payload->>'display_name' ILIKE '%Umayr%' OR o.payload->>'name' ILIKE '%Umayr%')
    ORDER BY pol.person_id, o.observed_at DESC NULLS LAST
  )
  SELECT * FROM latest
`);
out.umayr_samples = umayr.rows;

// Meet — person whose UUID starts with 24e45dc3
const meet = await pgClient.query(`
  WITH latest AS (
    SELECT DISTINCT ON (pol.person_id)
      pol.person_id,
      o.id AS observation_id,
      o.observed_at,
      o.payload
    FROM person_observation_links pol
    JOIN observations o ON o.id = pol.observation_id
    WHERE o.kind = 'person' AND pol.person_id::text LIKE $1
    ORDER BY pol.person_id, o.observed_at DESC NULLS LAST
  )
  SELECT * FROM latest
`, [MEET_PID_PREFIX + "%"]);
out.meet_samples = meet.rows;

// Topic chips for Meet + Umayr (for before/after topic_count delta)
if (out.meet_samples.length > 0) {
  const mpid = out.meet_samples[0].person_id;
  const chips = await pgClient.query(
    "SELECT topic, weight FROM person_topics WHERE person_id=$1 ORDER BY weight DESC",
    [mpid]
  );
  out.meet_topic_chips = chips.rows;
}
if (out.umayr_samples.length > 0) {
  const upid = out.umayr_samples[0].person_id;
  const chips = await pgClient.query(
    "SELECT topic, weight FROM person_topics WHERE person_id=$1 ORDER BY weight DESC",
    [upid]
  );
  out.umayr_topic_chips = chips.rows;
}

await pgClient.end();
await driver.close();

const outPath = path.resolve(__dirname, `tick-${label}.json`);
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${outPath}`);
console.log(JSON.stringify({
  observations_total: out.observations_total,
  observations_by_kind: out.observations_by_kind,
  persons_total: out.persons_total,
  persons_without_person_obs: out.persons_without_person_obs,
  neo4j_person_count: out.neo4j_person_count,
  neo4j_edges_by_type: out.neo4j_edges_by_type,
  categories: out.category_distribution,
  umayr_hits: out.umayr_samples.length,
  meet_hits: out.meet_samples.length,
  meet_topic_chips: (out.meet_topic_chips||[]).length,
  umayr_topic_chips: (out.umayr_topic_chips||[]).length,
}, null, 2));
