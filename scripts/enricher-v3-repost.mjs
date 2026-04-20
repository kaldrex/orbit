#!/usr/bin/env node
/**
 * Phase D re-post — takes enriched-observations.ndjson and POSTs in chunks
 * of 100 to /observations as a raw JSON array (not wrapped in {observations}).
 *
 * Also refreshes the Phase E audit + canary after successful writes, and
 * rewrites report.md / summary.json with the final verdict.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "outputs", "stage-6-v3-2026-04-20");
const OBS_PATH = path.join(OUT_DIR, "enriched-observations.ndjson");
const SUMMARY_PATH = path.join(OUT_DIR, "summary.json");
const REPORT_PATH = path.join(OUT_DIR, "report.md");
const CONTEXT_PATH = path.join(OUT_DIR, "contexts.ndjson");

const SKIP_PERSON_IDS = new Set([
  "67050b91-5011-4ba6-b230-9a387879717a", // Umayr
  "9e7c0448-8a83-43d5-83b1-bfa4f6c40ba7", // Ramon
]);

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function elapsed(t0) { return `${((Date.now() - t0) / 1000).toFixed(1)}s`; }

async function main() {
  const t0 = Date.now();
  const apiUrl = process.env.ORBIT_API_URL;
  const apiKey = process.env.ORBIT_API_KEY;
  if (!apiUrl || !apiKey) throw new Error("ORBIT_API_URL / ORBIT_API_KEY required");

  // Load existing summary for merge
  const summary = JSON.parse(fs.readFileSync(SUMMARY_PATH, "utf-8"));

  // Load NDJSON
  const lines = fs.readFileSync(OBS_PATH, "utf-8").split("\n").filter(Boolean);
  const observations = lines.map((l) => JSON.parse(l));
  console.error(`[${elapsed(t0)}] Loaded ${observations.length} observations`);

  // Safety: drop anything targeting Umayr/Ramon
  const safeObs = observations.filter((o) => {
    const pid = o.evidence_pointer.replace("enrichment://stage-6-v3-2026-04-20/person-", "");
    return !SKIP_PERSON_IDS.has(pid);
  });
  const dropped = observations.length - safeObs.length;
  if (dropped > 0) console.error(`[${elapsed(t0)}] Dropped ${dropped} observations targeting skip-list`);

  const url = `${apiUrl.replace(/\/$/, "")}/observations`;
  const batches = chunk(safeObs, 100);
  console.error(`[${elapsed(t0)}] POSTing ${batches.length} batches of up to 100 to ${url}`);

  let inserted = 0, deduped = 0;
  const failedBatches = [];
  for (let i = 0; i < batches.length; i++) {
    const body = JSON.stringify(batches[i]);
    let attempt = 0, success = false, lastErr = null;
    while (attempt < 2 && !success) {
      attempt++;
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body,
        });
        const text = await r.text();
        if (!r.ok) {
          lastErr = `HTTP ${r.status}: ${text.slice(0, 300)}`;
          if (r.status >= 500 && attempt < 2) { await new Promise((res) => setTimeout(res, 1500)); continue; }
          throw new Error(lastErr);
        }
        const json = JSON.parse(text);
        inserted += json.inserted ?? 0;
        deduped += json.deduped ?? 0;
        success = true;
        console.error(`[${elapsed(t0)}] batch ${i + 1}/${batches.length} → inserted=${json.inserted} deduped=${json.deduped}`);
      } catch (e) { lastErr = e.message; }
    }
    if (!success) {
      failedBatches.push({ batch_index: i, count: batches[i].length, error: lastErr });
      console.error(`[${elapsed(t0)}] batch ${i + 1} FAILED — ${lastErr}`);
    }
  }

  console.error(`\n[${elapsed(t0)}] POST DONE: inserted=${inserted} deduped=${deduped} failed_batches=${failedBatches.length}`);

  // --- Phase E redo: fetch 10 random enriched cards + Umayr canary ---
  const ctxLines = fs.readFileSync(CONTEXT_PATH, "utf-8").split("\n").filter(Boolean);
  const contexts = ctxLines.map((l) => JSON.parse(l));
  const enrichedIds = safeObs.map((o) => o.evidence_pointer.replace("enrichment://stage-6-v3-2026-04-20/person-", ""));

  async function fetchCard(pid) {
    const r = await fetch(`${apiUrl.replace(/\/$/, "")}/person/${pid}/card`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    return r.json();
  }

  const sampleIds = [];
  const pool = [...enrichedIds];
  for (let i = 0; i < Math.min(10, pool.length); i++) {
    const idx = Math.floor(Math.random() * pool.length);
    sampleIds.push(pool.splice(idx, 1)[0]);
  }
  const audit = [];
  for (const pid of sampleIds) {
    const card = await fetchCard(pid);
    audit.push({
      person_id: pid,
      card_category: card?.card?.category,
      card_relationship: card?.card?.relationship_to_me,
      card_company: card?.card?.company,
      card_title: card?.card?.title,
    });
  }

  // Umayr canary
  const baselinePath = path.join(ROOT, "outputs", "verification", "2026-04-19-umayr-v0", "card.json");
  let canary = { ok: true };
  if (fs.existsSync(baselinePath)) {
    const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf-8"));
    const fresh = await fetchCard("67050b91-5011-4ba6-b230-9a387879717a");
    if (fresh?.error) {
      canary = { ok: false, error: fresh.error };
    } else {
      const stableKeys = ["name", "company", "title", "category", "phones", "emails", "relationship_to_me"];
      const changes = [];
      for (const k of stableKeys) {
        const a = baseline?.card?.[k];
        const b = fresh?.card?.[k];
        const aj = JSON.stringify(a);
        const bj = JSON.stringify(b);
        if (aj !== bj) changes.push({ path: k, before: a, after: b });
      }
      canary = { ok: changes.length === 0, diff: changes };
    }
  } else {
    canary = { ok: true, note: "baseline missing" };
  }

  // --- Update summary + report ---
  summary.obsWritten = safeObs.length;
  summary.inserted = inserted;
  summary.deduped = deduped;
  summary.postFailedBatches = failedBatches.length;
  summary.audit = audit;
  summary.canary = canary;

  let verdict;
  if (failedBatches.length > 0 || (summary.failedBatchCount ?? 0) > 0) {
    verdict = `STAGE6_V3_PARTIAL: ${summary.failedBatchCount} LLM batches failed, ${failedBatches.length} POST batches failed`;
  } else if (!canary.ok) {
    verdict = "STAGE6_V3_PARTIAL: Umayr canary regressed";
  } else {
    verdict = "STAGE6_V3_PASS";
  }
  summary.verdict = verdict;
  summary.notes = (summary.notes ?? []).concat([
    `REPOST: ${inserted} inserted, ${deduped} deduped, ${failedBatches.length} failed via enricher-v3-repost.mjs`,
  ]);

  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));

  const auditTable = audit.map((a) =>
    `| ${a.person_id.slice(0, 8)} | ${a.card_category ?? "-"} | ${(a.card_relationship ?? "").slice(0, 80).replace(/\|/g, "\\|")} | ${a.card_company ?? "-"} | ${a.card_title ?? "-"} |`
  ).join("\n");

  const md = `# Stage 6 V3 — Enrichment Report (REPOST)

**Verdict:** \`${verdict}\`
**Repost at:** ${new Date().toISOString()}

## Inputs / outputs
- Skeleton persons: ${summary.skeletonCount}
- Enriched: ${summary.enrichedCount}
- Failed LLM batches: ${summary.failedBatchCount}
- Observations written to NDJSON: ${safeObs.length}
- Observations inserted (DB): ${inserted}
- Observations deduped (DB): ${deduped}
- POST failed batches: ${failedBatches.length}

## Token usage (from original run)
- Input tokens: ${summary.tokens.input_tokens.toLocaleString()}
- Output tokens: ${summary.tokens.output_tokens.toLocaleString()}
- Cache read tokens: ${summary.tokens.cache_read_input_tokens.toLocaleString()}
- **Estimated cost: $${summary.cost.toFixed(3)}**

## Sample audit (${audit.length} cards — fetched AFTER repost)
| person_id | category | relationship_to_me (truncated) | company | title |
|-----------|----------|-------------------------------|---------|-------|
${auditTable}

## Umayr canary
- ok: ${canary.ok}
- detail: ${JSON.stringify(canary).slice(0, 1800)}

## Notes
${summary.notes.map((n) => `- ${n}`).join("\n")}
`;
  fs.writeFileSync(REPORT_PATH, md);
  console.error(`[${elapsed(t0)}] Report rewritten → ${REPORT_PATH}`);
  console.error(`\n=== ${verdict} ===\n`);
}

main().catch((e) => { console.error(`FATAL: ${e.stack || e.message}`); process.exit(1); });
