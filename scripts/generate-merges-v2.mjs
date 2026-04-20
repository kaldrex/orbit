#!/usr/bin/env node
// scripts/generate-merges-v2.mjs
//
// Bridge-aware merge generator. For each person-observation in Stage 5c
// observations.ndjson, emit a kind:"merge" observation that materializes
// the person in the persons table + links the observation.
//
// Differs from Stage 5b:
//   - Queries existing persons by phone/email overlap BEFORE minting a
//     new person_id. If a pre-existing person matches (Umayr, Ramon),
//     reuse their id — preserves enriched category/relationship_to_me.
//   - Defensive: if a manifest row matches TWO existing persons
//     (pathological, should not happen post-safety), the merge is
//     written to conflicts.ndjson and SKIPPED rather than forking.
//
// Workaround (plan D5, tracked for later): the merge payload schema
// requires `merged_observation_ids.min(2)`. We use [obsId, obsId]. See
// memory/tech_merge_min2_workaround.md.

import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

const IN_OBS = resolve(
  REPO_ROOT,
  "outputs/stage-5c-reingest-2026-04-20/observations.ndjson",
);
const OUT_DIR = resolve(REPO_ROOT, "outputs/stage-5c-reingest-2026-04-20");
const OUT_MERGES = resolve(OUT_DIR, "merges.ndjson");
const OUT_CONFLICTS = resolve(OUT_DIR, "conflicts.ndjson");
const OUT_SUMMARY = resolve(OUT_DIR, "merges-summary.json");

mkdirSync(OUT_DIR, { recursive: true });

const DRY_RUN = process.argv.includes("--dry-run");

/**
 * Build the bridge-lookup table from existing DB state. Each entry maps
 * `phone:<e164>` or `email:<lc>` to a person_id. Caller queries this
 * map; O(1) in-memory.
 *
 * Data source: existingPersons = [{id, phones, emails}, ...].
 */
export function buildBridgeIndex(existingPersons) {
  const idx = new Map();
  for (const p of existingPersons ?? []) {
    for (const ph of p.phones ?? []) {
      if (typeof ph === "string" && ph) idx.set(`phone:${ph}`, p.id);
    }
    for (const em of p.emails ?? []) {
      if (typeof em === "string" && em) {
        idx.set(`email:${em.toLowerCase()}`, p.id);
      }
    }
  }
  return idx;
}

/**
 * Given a manifest person observation row and an existing-person bridge
 * index, decide which person_id this observation should merge into.
 *
 * Returns:
 *   - {kind:"existing", person_id, reason}
 *   - {kind:"new", person_id}   — fresh UUID
 *   - {kind:"conflict", person_ids[], reason} — matches multiple
 */
export function decideMergeTarget(obs, bridgeIndex) {
  const phones = obs?.payload?.phones ?? [];
  const emails = obs?.payload?.emails ?? [];
  const hits = new Set();
  for (const ph of phones) {
    const id = bridgeIndex.get(`phone:${ph}`);
    if (id) hits.add(id);
  }
  for (const em of emails) {
    const id = bridgeIndex.get(`email:${String(em).toLowerCase()}`);
    if (id) hits.add(id);
  }
  if (hits.size === 0) {
    return { kind: "new", person_id: randomUUID() };
  }
  if (hits.size === 1) {
    return {
      kind: "existing",
      person_id: [...hits][0],
      reason: `matched existing person via ${phones.length > 0 ? "phone" : "email"}`,
    };
  }
  return {
    kind: "conflict",
    person_ids: [...hits],
    reason: "manifest row matches multiple existing persons",
  };
}

/**
 * Build the merge observation envelope for a given person-observation.
 * The [obsId, obsId] pattern is the .min(2) workaround.
 */
export function buildMergeObservation({ obs, obsId, personId }) {
  const phones = obs?.payload?.phones ?? [];
  const emails = obs?.payload?.emails ?? [];
  const bridges = [
    ...phones.map((p) => `phone:${p}`),
    ...emails.map((e) => `email:${String(e).toLowerCase()}`),
  ];
  return {
    observed_at: obs.observed_at,
    observer: "wazowski",
    kind: "merge",
    evidence_pointer: `reingest-merge-20260420://${obsId}`,
    confidence: 0.85,
    reasoning: `Bridge-aware merge from Stage 5c reingest. Target person_id=${personId}.`,
    payload: {
      person_id: personId,
      deterministic_bridges: bridges,
      // TODO(schema-min2): see outputs/cleanup-plan-2026-04-20/plan.md §5 D5
      merged_observation_ids: [obsId, obsId],
    },
  };
}

async function fetchExistingPersons() {
  const env = Object.fromEntries(
    readFileSync(resolve(REPO_ROOT, ".env.local"), "utf8")
      .split("\n")
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => {
        const idx = l.indexOf("=");
        return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
      }),
  );
  const base = env.ORBIT_API_URL;
  const key = env.ORBIT_API_KEY;
  if (!base || !key) {
    throw new Error(
      "generate-merges-v2: ORBIT_API_URL/ORBIT_API_KEY must be in .env.local",
    );
  }
  // Call the new /persons/enriched endpoint (Phase C1). If we can't, fall
  // back to empty — then all 1,603 rows become new persons (safe but
  // loses Umayr/Ramon bridge).
  const url = `${base.replace(/\/+$/, "")}/persons/enriched?limit=2000`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      console.error(
        `[generate-merges-v2] warning: GET ${url} returned ${res.status}; proceeding with empty bridge index`,
      );
      return [];
    }
    const j = await res.json();
    return j.persons ?? [];
  } catch (e) {
    console.error(
      `[generate-merges-v2] warning: fetch failed: ${e?.message ?? e}; proceeding with empty bridge index`,
    );
    return [];
  }
}

async function main() {
  const existingPersons = await fetchExistingPersons();
  const bridgeIndex = buildBridgeIndex(existingPersons);
  console.error(
    `[generate-merges-v2] bridge index: ${bridgeIndex.size} entries from ${existingPersons.length} existing persons`,
  );

  const mergeStream = createWriteStream(OUT_MERGES, { encoding: "utf8" });
  const conflictStream = createWriteStream(OUT_CONFLICTS, { encoding: "utf8" });

  const inStream = createReadStream(IN_OBS, { encoding: "utf8" });
  const rl = createInterface({ input: inStream, crlfDelay: Infinity });

  let total = 0;
  let bindExisting = 0;
  let createNew = 0;
  let conflicts = 0;
  const perPersonHits = Object.create(null);

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;
    total += 1;
    let obs;
    try {
      obs = JSON.parse(line);
    } catch (e) {
      conflictStream.write(
        JSON.stringify({
          line_number: total,
          reason: `json parse: ${e?.message ?? e}`,
        }) + "\n",
      );
      conflicts += 1;
      continue;
    }
    const decision = decideMergeTarget(obs, bridgeIndex);
    if (decision.kind === "conflict") {
      conflictStream.write(
        JSON.stringify({
          line_number: total,
          reason: decision.reason,
          matched_person_ids: decision.person_ids,
          manifest_id: obs?.evidence_pointer ?? null,
          name: obs?.payload?.name ?? null,
        }) + "\n",
      );
      conflicts += 1;
      continue;
    }
    if (decision.kind === "existing") {
      bindExisting += 1;
      perPersonHits[decision.person_id] =
        (perPersonHits[decision.person_id] ?? 0) + 1;
    } else {
      createNew += 1;
    }
    // obsId here is the NEW id the server will mint when upserting the
    // person observation. We don't have that yet — we need to post the
    // person obs first, capture id, then build the merge. This script
    // therefore writes a plan, not a direct merge payload. Re-ingest
    // script consumes this plan in two passes.
    const plan = {
      person_obs_line: total,
      target: decision,
      obs,
    };
    mergeStream.write(JSON.stringify(plan) + "\n");
  }

  mergeStream.end();
  conflictStream.end();

  const summary = {
    dry_run: DRY_RUN,
    total_manifest_person_obs: total,
    would_bind_to_existing_person: bindExisting,
    would_create_new_person: createNew,
    conflicts,
    existing_person_hits: perPersonHits,
    bridge_index_size: bridgeIndex.size,
  };
  writeFileSync(OUT_SUMMARY, JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("generate-merges-v2 failed:", e);
    process.exit(1);
  });
}
