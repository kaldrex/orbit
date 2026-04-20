#!/usr/bin/env node
// scripts/manifest-to-observations.mjs
//
// Stage 5c transformer (2026-04-20 rebuild). Reads
// outputs/manifest-hypothesis-2026-04-19/orbit-manifest-v3.ndjson line-by-line
// and emits one kind:"person" observation per surviving line into
// outputs/stage-5c-reingest-2026-04-20/observations.ndjson.
//
// Safety rules enforced via orbit-rules-plugin/lib/safety.mjs. Rows that
// trip the filter land in skipped.ndjson — NOT in observations.ndjson,
// regardless of other fields present. No phone/email fallback names —
// if the row has no safe name, it gets skipped.
//
// Change log vs Stage 5:
//   - INPUT switched v2 → v3 (v2 was missing the group-name fix).
//   - OUT_DIR switched to outputs/stage-5c-reingest-2026-04-20/ (preserve
//     Stage 5 as audit evidence).
//   - Name picker dropped the "emails[0] || phones[0] || 'Unknown'"
//     fallback — that was the load-bearing bug that landed 5,199
//     phone/email/unicode-masked/quoted-literal names.
//   - relationship_to_me is set to "" (empty string — per plan D3). The
//     API will render "Not yet described" when empty at read time.
//   - evidence_pointer prefix updated to reingest-20260420:// so the
//     new cohort is distinguishable from Stage-5 manifest:// rows.
//
// This is pure plumbing + a deterministic shape. No LLM, no inference.

import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { safetyDropReason } from "../orbit-rules-plugin/lib/safety.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

const INPUT = resolve(
  REPO_ROOT,
  "outputs/manifest-hypothesis-2026-04-19/orbit-manifest-v3.ndjson",
);
const OUT_DIR = resolve(REPO_ROOT, "outputs/stage-5c-reingest-2026-04-20");
const OUT_OBS = resolve(OUT_DIR, "observations.ndjson");
const OUT_SKIP = resolve(OUT_DIR, "skipped.ndjson");

mkdirSync(OUT_DIR, { recursive: true });

// Seed-observation baseline: re-ingest rows represent "we know this
// identity exists" — they're the LOWEST-confidence signal and must be
// folded BEFORE any LLM-enriched observation. Card-assembler uses
// observed_at for fold ordering, so we pin all seeds to a fixed
// pre-enrichment timestamp.
const SEED_OBSERVED_AT = "2026-04-18T00:00:00+00:00";

export function manifestToObservation(m) {
  const sources = Object.keys(m.source_provenance ?? {}).filter(
    (k) => m.source_provenance[k] === true,
  );
  // Seed observations are pinned to the fixed pre-enrichment baseline.
  // We deliberately DO NOT use m.last_seen here — last_seen can post-date
  // enrichment and mechanically overwrite richer fields on the fold.
  const observed_at_with_offset = SEED_OBSERVED_AT;
  return {
    observed_at: observed_at_with_offset,
    observer: "wazowski",
    kind: "person",
    evidence_pointer: `reingest-20260420://${m.id ?? "unknown"}`,
    confidence: 0.85,
    reasoning: `Derived from deterministic manifest generation across ${sources.join("+") || "no-provenance"}. Rules-only, pending LLM enrichment.`,
    payload: {
      name: String(m.name).trim().slice(0, 256),
      phones: Array.isArray(m.phones) ? m.phones.filter(Boolean) : [],
      emails: Array.isArray(m.emails) ? m.emails.filter(Boolean) : [],
      company: null,
      title: null,
      category: "other",
      // Empty string signals "no enrichment yet" — the UI renders
      // "Not yet described". Never emit placeholder prose here; doing so
      // masks the real enrichment gap.
      relationship_to_me: "",
    },
  };
}

/**
 * Apply the safety filter + zero-identifier check to a manifest row.
 * Returns {kind:"emit", obs} | {kind:"skip", reason}.
 */
export function classifyManifestRow(m) {
  const phones = Array.isArray(m.phones) ? m.phones.filter(Boolean) : [];
  const emails = Array.isArray(m.emails) ? m.emails.filter(Boolean) : [];
  if (phones.length === 0 && emails.length === 0) {
    return { kind: "skip", reason: "zero_identifiers" };
  }
  const dropReason = safetyDropReason({
    name: m.name ?? "",
    emails,
    phones,
  });
  if (dropReason) {
    return { kind: "skip", reason: dropReason };
  }
  return { kind: "emit", obs: manifestToObservation(m) };
}

async function main() {
  const obsStream = createWriteStream(OUT_OBS, { encoding: "utf8" });
  const skipStream = createWriteStream(OUT_SKIP, { encoding: "utf8" });

  const inStream = createReadStream(INPUT, { encoding: "utf8" });
  const rl = createInterface({ input: inStream, crlfDelay: Infinity });

  let total = 0;
  let emitted = 0;
  let skipped = 0;
  const reasonCounts = Object.create(null);

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;
    total += 1;
    let m;
    try {
      m = JSON.parse(line);
    } catch (e) {
      skipped += 1;
      reasonCounts["json_parse"] = (reasonCounts["json_parse"] ?? 0) + 1;
      skipStream.write(
        JSON.stringify({
          line_number: total,
          reason: `json parse: ${e?.message ?? e}`,
          raw: line.slice(0, 200),
        }) + "\n",
      );
      continue;
    }
    const r = classifyManifestRow(m);
    if (r.kind === "skip") {
      skipped += 1;
      reasonCounts[r.reason] = (reasonCounts[r.reason] ?? 0) + 1;
      skipStream.write(
        JSON.stringify({
          line_number: total,
          reason: r.reason,
          manifest_id: m.id ?? null,
          name: m.name ?? null,
        }) + "\n",
      );
      continue;
    }
    obsStream.write(JSON.stringify(r.obs) + "\n");
    emitted += 1;
  }

  obsStream.end();
  skipStream.end();

  const summary = {
    input: INPUT,
    output_observations: OUT_OBS,
    output_skipped: OUT_SKIP,
    total_manifest_lines: total,
    emitted,
    skipped,
    skip_reason_counts: reasonCounts,
  };
  console.log(JSON.stringify(summary, null, 2));
}

// Only invoke main() when run as a CLI — allows tests to import
// classifyManifestRow / manifestToObservation without side effects.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("transformer failed:", e);
    process.exit(1);
  });
}
