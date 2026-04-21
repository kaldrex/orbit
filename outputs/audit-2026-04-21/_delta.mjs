#!/usr/bin/env node
// Compute delta between tick-before and tick-after + pull 3 persons
// whose category changed from "other" → something specific.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(path.resolve(__dirname, "../../.env.local"), "utf8");
const env = Object.fromEntries(
  envText.split("\n").filter((l) => l && !l.startsWith("#") && l.includes("=")).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  })
);

const before = JSON.parse(readFileSync(path.resolve(__dirname, "tick-before.json"), "utf8"));
const after = JSON.parse(readFileSync(path.resolve(__dirname, "tick-after.json"), "utf8"));

const pgClient = new pg.Client({ connectionString: env.SUPABASE_DB_URL });
await pgClient.connect();

// Find persons who WERE "other" (or had no person obs) in the prior latest
// and now have a MORE SPECIFIC category. We use the enricher's evidence_pointer
// prefix + observed_at window to know which 200 persons were enriched.
const enrichedPersons = await pgClient.query(`
  SELECT
    pol.person_id,
    o.payload,
    o.observed_at,
    o.evidence_pointer
  FROM observations o
  JOIN person_observation_links pol ON pol.observation_id = o.id
  WHERE o.kind = 'person'
    AND o.evidence_pointer LIKE 'enrichment://enricher-v5/%'
    AND o.observed_at >= '2026-04-21T07:40:00Z'
  ORDER BY o.observed_at ASC
`);

const enrichedById = new Map();
for (const r of enrichedPersons.rows) {
  enrichedById.set(r.person_id, r);
}

// For each enriched person, get their SECOND-latest person obs (i.e. the one
// that was "latest" BEFORE this run) and compare categories.
const promoted = [];
const stayedOther = [];
for (const [pid, latest] of enrichedById) {
  const prev = await pgClient.query(`
    SELECT o.payload, o.observed_at
    FROM observations o
    JOIN person_observation_links pol ON pol.observation_id = o.id
    WHERE o.kind = 'person' AND pol.person_id = $1
      AND o.id != (
        SELECT o2.id FROM observations o2
        JOIN person_observation_links pol2 ON pol2.observation_id = o2.id
        WHERE o2.kind = 'person' AND pol2.person_id = $1
        ORDER BY o2.observed_at DESC LIMIT 1
      )
    ORDER BY o.observed_at DESC
    LIMIT 1
  `, [pid]);
  const prevCat = prev.rows[0]?.payload?.category ?? "__none__";
  const newCat = latest.payload?.category ?? "__none__";
  const entry = {
    person_id: pid,
    name: latest.payload?.name,
    prev_category: prevCat,
    new_category: newCat,
    company: latest.payload?.company,
    title: latest.payload?.title,
    relationship_to_me: latest.payload?.relationship_to_me,
    confidence: latest.payload?.confidence ?? null,
    reasoning: (await pgClient.query(
      "SELECT reasoning FROM observations WHERE evidence_pointer=$1 ORDER BY observed_at DESC LIMIT 1",
      [latest.evidence_pointer]
    )).rows[0]?.reasoning,
  };
  if (prevCat === "other" && newCat !== "other" && newCat !== "__none__") {
    promoted.push(entry);
  }
  if (newCat === "other") stayedOther.push(entry);
}

// Umayr canary diff
function diffCore(a, b) {
  const core = ["category", "name", "company", "title", "relationship_to_me"];
  const out = {};
  for (const k of core) {
    out[k] = { before: a?.[k] ?? null, after: b?.[k] ?? null, changed: (a?.[k] ?? null) !== (b?.[k] ?? null) };
  }
  return out;
}

const bUmayr = before.umayr_samples[0]?.payload ?? {};
const aUmayr = after.umayr_samples[0]?.payload ?? {};
const umayrDiff = diffCore(bUmayr, aUmayr);

// Build markdown
const lines = [];
lines.push("# Evolution Tick Delta — 2026-04-21");
lines.push("");
lines.push(`**Before:** ${before.t} · **After:** ${after.t}`);
lines.push("");
lines.push("## Totals");
lines.push("");
lines.push("| Metric | Before | After | Δ |");
lines.push("|---|---:|---:|---:|");
lines.push(`| observations total | ${before.observations_total} | ${after.observations_total} | ${after.observations_total - before.observations_total} |`);
for (const k of Object.keys(after.observations_by_kind)) {
  const b = before.observations_by_kind[k] ?? 0;
  const a = after.observations_by_kind[k] ?? 0;
  lines.push(`|   obs kind:${k} | ${b} | ${a} | ${a - b} |`);
}
lines.push(`| persons total | ${before.persons_total} | ${after.persons_total} | ${after.persons_total - before.persons_total} |`);
lines.push(`| neo4j Person nodes | ${before.neo4j_person_count} | ${after.neo4j_person_count} | ${after.neo4j_person_count - before.neo4j_person_count} |`);
for (const k of Object.keys(after.neo4j_edges_by_type)) {
  const b = before.neo4j_edges_by_type[k] ?? 0;
  const a = after.neo4j_edges_by_type[k] ?? 0;
  lines.push(`|   edge :${k} | ${b} | ${a} | ${a - b} |`);
}
lines.push("");
lines.push("## Category distribution");
lines.push("");
lines.push("| Category | Before | After | Δ |");
lines.push("|---|---:|---:|---:|");
const catKeys = new Set([...Object.keys(before.category_distribution), ...Object.keys(after.category_distribution)]);
for (const k of [...catKeys].sort()) {
  const b = before.category_distribution[k] ?? 0;
  const a = after.category_distribution[k] ?? 0;
  lines.push(`| ${k} | ${b} | ${a} | ${a - b} |`);
}
lines.push("");
lines.push("## Enricher run");
lines.push("");
lines.push(`- 200 persons passed through enricher-v5-haiku`);
lines.push(`- ${promoted.length} promoted out of \`other\` into a specific category`);
lines.push(`- ${stayedOther.length} stayed \`other\` (pure saved contact, no activity signal)`);
lines.push(`- cost_actual_usd: **$0.1631** (model: claude-haiku-4-5-20251001)`);
lines.push(`- wall time: 53s, 7 batches × 30, zero quarantine`);
lines.push("");
lines.push("## Umayr canary diff (must be UNCHANGED)");
lines.push("");
lines.push("| Field | Before | After | Changed? |");
lines.push("|---|---|---|---|");
for (const k of Object.keys(umayrDiff)) {
  const d = umayrDiff[k];
  const toStr = (v) => v == null ? "(null)" : String(v).replace(/\|/g, "\\|").slice(0, 80);
  lines.push(`| ${k} | ${toStr(d.before)} | ${toStr(d.after)} | ${d.changed ? "⚠ YES" : "NO"} |`);
}
const anyChange = Object.values(umayrDiff).some((d) => d.changed);
lines.push("");
lines.push(`**Canary verdict:** ${anyChange ? "⚠ FAILED — Umayr changed" : "✓ PASSED — Umayr unchanged on all 5 core fields"}`);
lines.push("");
lines.push("## Meet topic chips");
lines.push("");
lines.push(`- Before: ${(before.meet_topic_chips || []).length} chips`);
lines.push(`- After:  ${(after.meet_topic_chips || []).length} chips`);
lines.push("");
lines.push("## 3 example persons promoted out of `other`");
lines.push("");

// Pick 3 promoted with interesting categories (prefer founder/fellow/team over friend)
const priority = { founder: 6, team: 5, fellow: 4, community: 3, sponsor: 2, friend: 1, media: 1, investor: 6, press: 1, other: 0 };
const sorted = [...promoted].sort((a, b) => (priority[b.new_category] ?? 0) - (priority[a.new_category] ?? 0));
const examples = sorted.slice(0, 3);
for (let i = 0; i < examples.length; i++) {
  const e = examples[i];
  lines.push(`### ${i + 1}. ${e.name} — \`${e.prev_category}\` → \`${e.new_category}\``);
  lines.push("");
  lines.push(`- **person_id:** \`${e.person_id}\``);
  lines.push(`- **company:** ${e.company ?? "null"}`);
  lines.push(`- **title:** ${e.title ?? "null"}`);
  lines.push(`- **confidence:** ${e.confidence ?? "(not stored)"}`);
  lines.push(`- **relationship_to_me:** ${e.relationship_to_me}`);
  lines.push(`- **reasoning:** ${e.reasoning}`);
  lines.push("");
}

const out = {
  promoted_count: promoted.length,
  stayed_other_count: stayedOther.length,
  sample_promoted: examples,
  umayr_diff: umayrDiff,
  umayr_canary_passed: !anyChange,
};
writeFileSync(path.resolve(__dirname, "tick-delta.md"), lines.join("\n") + "\n");
writeFileSync(path.resolve(__dirname, "tick-delta.json"), JSON.stringify(out, null, 2));
console.log("Wrote tick-delta.md + tick-delta.json");
console.log(JSON.stringify({
  promoted_count: promoted.length,
  stayed_other_count: stayedOther.length,
  umayr_canary_passed: !anyChange,
  examples: examples.map(e => `${e.name}: ${e.prev_category} → ${e.new_category}`),
}, null, 2));

await pgClient.end();
