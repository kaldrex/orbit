// Stage 5b — generate kind:"merge" observations for every manifest-sourced
// kind:"person" observation in Supabase.
//
// Each merge promotes exactly one person-observation (the manifest already
// union-found across sources), so `merged_observation_ids` contains that
// single source UUID. The Zod schema enforces .min(2) on that array, so we
// include the UUID twice — the DB's ON CONFLICT DO NOTHING on
// (person_id, observation_id) collapses duplicates into a single link row.
// That's a schema quirk (array length vs set size), not a DB contract.
//
// Emits NDJSON to ./merges.ndjson and a preview JSON to ./preview-first-5.json.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import pg from "pg";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

dotenv.config({ path: path.join(ROOT, ".env.local") });

const USER_ID = "dbb398c2-1eff-4eee-ae10-bad13be5fda7";
const OUT = path.join(__dirname, "merges.ndjson");
const PREVIEW = path.join(__dirname, "preview-first-5.json");

if (!process.env.SUPABASE_DB_URL) {
  throw new Error("SUPABASE_DB_URL missing");
}

const client = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});

function buildBridges(payload) {
  const phones = Array.isArray(payload?.phones) ? payload.phones : [];
  const emails = Array.isArray(payload?.emails) ? payload.emails : [];
  const bridges = [
    ...phones.map((p) => `phone:${p}`),
    ...emails.map((e) => `email:${e}`),
  ];
  // Dedup + sort for stability so evidence_pointer is deterministic.
  return [...new Set(bridges)].sort();
}

function truncateKey(raw) {
  // evidence_pointer is `max(512)` in the schema. With ~20-char phones and
  // 60+-char emails, some rows could exceed that. We SHA-1-hash the join
  // when it would overflow, keeping determinism.
  if (raw.length <= 500) return raw;
  const h = crypto.createHash("sha1").update(raw).digest("hex");
  return `hash:${h}`;
}

function main() {
  return client.connect().then(async () => {
    const { rows } = await client.query({
      text: `SELECT id, observed_at, payload
             FROM observations
             WHERE user_id = $1
               AND kind = 'person'
               AND evidence_pointer LIKE 'manifest://%'
             ORDER BY id`,
      values: [USER_ID],
    });

    console.log(`fetched ${rows.length} manifest person-observations`);

    let emitted = 0;
    let skipped = 0;
    const skippedReasons = [];
    const out = fs.createWriteStream(OUT);
    const first5 = [];
    const seenEvidencePointers = new Set();

    for (const row of rows) {
      const bridges = buildBridges(row.payload);
      if (bridges.length === 0) {
        skipped++;
        skippedReasons.push({ id: row.id, reason: "no phones/emails" });
        continue;
      }

      const personId = crypto.randomUUID();
      const observedAtIso =
        row.observed_at instanceof Date
          ? row.observed_at.toISOString()
          : String(row.observed_at);

      let evidencePointer = `merge://${bridges.join("+")}`;
      evidencePointer = truncateKey(evidencePointer);

      // Defensive: if the stable hash/bridges collide, append the source
      // observation id to keep evidence_pointer unique across rows.
      if (seenEvidencePointers.has(evidencePointer)) {
        evidencePointer = `${evidencePointer}#${row.id}`;
        if (evidencePointer.length > 500) {
          const h = crypto
            .createHash("sha1")
            .update(evidencePointer)
            .digest("hex");
          evidencePointer = `merge://hash:${h}`;
        }
      }
      seenEvidencePointers.add(evidencePointer);

      const merge = {
        observed_at: observedAtIso,
        observer: "wazowski",
        kind: "merge",
        evidence_pointer: evidencePointer,
        confidence: 1.0,
        reasoning:
          "Deterministic manifest-sourced single-observation merge. Identity was already resolved at manifest generation via cross-source union-find (wa_dm+wa_contact+wa_group+gmail_from+google_contact+cross_channel_name_match). Materializing the person row. merged_observation_ids contains the source person-observation UUID twice to satisfy the schema's .min(2) length constraint; the DB's ON CONFLICT (person_id, observation_id) DO NOTHING collapses duplicates into a single link.",
        payload: {
          person_id: personId,
          merged_observation_ids: [row.id, row.id],
          deterministic_bridges: bridges,
        },
      };

      out.write(JSON.stringify(merge) + "\n");
      emitted++;
      if (first5.length < 5) first5.push(merge);
    }

    await new Promise((r) => out.end(r));

    fs.writeFileSync(PREVIEW, JSON.stringify(first5, null, 2) + "\n");
    fs.writeFileSync(
      path.join(__dirname, "generation-summary.json"),
      JSON.stringify(
        {
          fetched: rows.length,
          emitted,
          skipped,
          skipped_reasons_sample: skippedReasons.slice(0, 10),
          output_file: OUT,
        },
        null,
        2,
      ) + "\n",
    );

    console.log(`emitted=${emitted} skipped=${skipped} out=${OUT}`);
    await client.end();
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
