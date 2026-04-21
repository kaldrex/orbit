#!/usr/bin/env node
// scripts/build-interactions-from-raw-events.mjs
//
// Phase 1 pipeline: turn raw_events (source='whatsapp') into
// kind:"interaction" observations in Orbit.
//
// Run with env loaded from .env.local:
//   node --env-file=.env.local scripts/build-interactions-from-raw-events.mjs [flags]
//
// Flags:
//   --dry-run             Print the first 10 unique-sender payloads to stdout;
//                         do NOT POST anything. Exit 0.
//   --limit <N>           Process + POST at most N raw_events (Phase B test).
//                         Default: unbounded (full run).
//   --resume              Reuse progress.json from prior run (default).
//   --no-resume           Ignore progress.json — start fresh.
//
// Pipeline shape (per batch of 100 raw_events):
//   1. Build interaction payloads keyed on deterministic evidence_pointer.
//   2. POST /api/v1/observations (bulk of 100 interactions).
//   3. Direct-DB read-only SELECT id, evidence_pointer FROM observations
//      WHERE evidence_pointer IN (...) AND kind='interaction' → map.
//   4. Build merge observations (merged_observation_ids=[iid, iid] per the
//      min(2) workaround; target person_id from phone→person map).
//   5. POST /api/v1/observations (bulk of 100 merges).
//
// API is the only writer; the pg.Client is purely for reads (raw_events
// ingress + evidence_pointer→id post-insert lookup + person bridge index).

import { readFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { ResilientWorker } from "./lib/resilient-worker.mjs";
import { normalizePhone } from "../orbit-rules-plugin/lib/phone.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");
const OUT_DIR = resolve(
  REPO_ROOT,
  "outputs/interaction-pipeline-2026-04-21",
);

mkdirSync(OUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { dryRun: false, limit: null, resume: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--limit") {
      args.limit = parseInt(argv[++i], 10);
      if (!Number.isFinite(args.limit) || args.limit <= 0) {
        console.error(`[fatal] --limit expects a positive integer`);
        process.exit(2);
      }
    } else if (a === "--no-resume") args.resume = false;
    else if (a === "--resume") args.resume = true;
    else {
      console.error(`[fatal] unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Env loader
// ---------------------------------------------------------------------------

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[fatal] env ${name} not set — run with node --env-file=.env.local`);
    process.exit(2);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Person-resolution map
// ---------------------------------------------------------------------------
// Preload phone→person_id and email→person_id from existing persons.
// Source of truth: kind='person' observations linked via
// person_observation_links. Same pattern as the resolver SKILL's bridge
// index (see orbit-rules-plugin/lib/bridge.mjs).

async function buildResolverMaps(pool, userId) {
  const res = await pool.query(
    `
    SELECT
      l.person_id AS id,
      COALESCE(
        array_agg(DISTINCT p) FILTER (WHERE p IS NOT NULL),
        ARRAY[]::text[]
      ) AS phones,
      COALESCE(
        array_agg(DISTINCT e) FILTER (WHERE e IS NOT NULL),
        ARRAY[]::text[]
      ) AS emails,
      COALESCE(
        (array_agg(o.payload->>'name') FILTER (WHERE o.payload->>'name' IS NOT NULL))[1],
        ''
      ) AS any_name
    FROM person_observation_links l
    JOIN observations o ON o.id = l.observation_id
    LEFT JOIN LATERAL jsonb_array_elements_text(o.payload->'phones') AS p ON TRUE
    LEFT JOIN LATERAL jsonb_array_elements_text(o.payload->'emails') AS e ON TRUE
    WHERE o.user_id = $1
      AND o.kind = 'person'
    GROUP BY l.person_id
    `,
    [userId],
  );
  const phoneMap = new Map();
  const emailMap = new Map();
  const nameMap = new Map();
  for (const row of res.rows) {
    nameMap.set(row.id, row.any_name || "");
    for (const ph of row.phones) {
      if (ph) phoneMap.set(ph, row.id);
    }
    for (const em of row.emails) {
      if (em) emailMap.set(em.toLowerCase(), row.id);
    }
  }
  return { phoneMap, emailMap, nameMap, personCount: res.rows.length };
}

// ---------------------------------------------------------------------------
// Raw-event → interaction payload
// ---------------------------------------------------------------------------
// Handles DMs + unknowns. Groups are dropped because the sender JID is
// collapsed into the chat JID by the wacli connector (see recon
// agent-docs/10-eda-findings-2026-04-19.md §WA).
//
// Self-outbound is skipped when the resolved peer phone equals
// ORBIT_SELF_PHONE. If ORBIT_SELF_PHONE is unset, we fall back to the
// founder's known phone discovered during recon (+919136820958).

const FALLBACK_SELF_PHONE = "+919136820958";

function evidencePointerFor(row) {
  // Deterministic — raw_events has a UNIQUE (user_id, source, source_event_id)
  // constraint, so source_event_id uniquely identifies a row. We embed the
  // full source_event_id to make this reversible back to the ledger.
  return `wacli://messages/source_event_id=${row.source_event_id}`;
}

function classifyTopic(_bodyPreview) {
  // Deterministic default — the SKILL-side observer has 6 enum values but
  // zero deterministic signal in body_preview to pick between them. This
  // pass is deterministic; topic enrichment is a separate pass.
  return "business";
}

function buildInteractionObservation({
  row,
  peerPhoneE164,
  peerName,
  selfName,
}) {
  const direction = row.direction ?? "in";
  const bodyRaw = (row.body_preview ?? "").toString().trim();
  const bodyForSummary = bodyRaw || "(no preview)";
  const participants = [selfName, peerName || peerPhoneE164];
  const summary = `${direction === "out" ? "Outbound" : "Inbound"} WhatsApp message: ${bodyForSummary}`.slice(0, 2000);

  return {
    kind: "interaction",
    observed_at: new Date(row.occurred_at).toISOString(),
    observer: "wazowski",
    evidence_pointer: evidencePointerFor(row),
    confidence: 1.0,
    reasoning: `Deterministic projection of raw_events row (source=whatsapp, direction=${direction}, thread_id=${row.thread_id ?? "null"}). Sender phone ${peerPhoneE164} resolved to an existing person.`.slice(0, 2000),
    payload: {
      participants: participants.slice(0, 50).map((p) => String(p).slice(0, 256)),
      channel: "whatsapp",
      summary,
      topic: classifyTopic(bodyRaw),
      relationship_context: "",
      connection_context: "",
      sentiment: "neutral",
    },
  };
}

// ---------------------------------------------------------------------------
// Plan — resolve each raw_event to a person_id (or skip)
// ---------------------------------------------------------------------------

function peerNameFromParticipantsRaw(participantsRaw) {
  if (!Array.isArray(participantsRaw) || participantsRaw.length === 0) return null;
  const first = participantsRaw[0];
  if (!first || typeof first !== "object") return null;
  const name = first.name;
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  // "me" is a wacli-side placeholder for the founder's outbound, not a
  // real peer name. Drop it.
  if (trimmed.toLowerCase() === "me") return null;
  return trimmed;
}

function planFromRow({ row, phoneMap, selfPhone }) {
  const msgKind = row.raw_ref?.kind;
  if (!msgKind) {
    return { skip: true, reason: "no_msg_kind" };
  }
  if (msgKind === "group") {
    // Group-in/out: participant_phones holds Sanchay's phone when present;
    // the per-message sender JID is not in participants_raw for this
    // connector. Drop — would need a separate group-participant pipeline.
    return { skip: true, reason: "group_msg" };
  }
  const rawPhone = Array.isArray(row.participant_phones) ? row.participant_phones[0] : null;
  if (!rawPhone) {
    return { skip: true, reason: "no_phone" };
  }
  const normalized = normalizePhone({ phone: rawPhone });
  if (!normalized.valid || !normalized.e164) {
    return { skip: true, reason: "phone_not_normalizable" };
  }
  const peerPhone = normalized.e164;
  if (peerPhone === selfPhone) {
    // Sanchay's own phone appears as participant_phones[0] for group-kind
    // rows (filtered above) and some edge cases. Skip self-referential.
    return { skip: true, reason: "self_phone" };
  }
  const personId = phoneMap.get(peerPhone);
  if (!personId) {
    return { skip: true, reason: "unresolved_phone", peer_phone: peerPhone };
  }
  const peerName = peerNameFromParticipantsRaw(row.participants_raw);
  return {
    skip: false,
    person_id: personId,
    peer_phone: peerPhone,
    peer_name: peerName,
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, bodyPreview) {
    super(`HTTP ${status} ${bodyPreview ?? ""}`);
    this.status = status;
    this.bodyPreview = bodyPreview;
  }
}

async function postObservations(apiBase, apiKey, observations) {
  const res = await fetch(`${apiBase}/observations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(observations),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new HttpError(res.status, text.slice(0, 400));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(res.status, `invalid json: ${text.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Evidence-pointer → observation_id lookup (read-only DB)
// ---------------------------------------------------------------------------

async function lookupObservationIds({ pool, userId, evidencePointers }) {
  if (evidencePointers.length === 0) return new Map();
  const res = await pool.query(
    `
    SELECT id, evidence_pointer
    FROM observations
    WHERE user_id = $1
      AND kind = 'interaction'
      AND evidence_pointer = ANY($2::text[])
    `,
    [userId, evidencePointers],
  );
  const map = new Map();
  for (const row of res.rows) map.set(row.evidence_pointer, row.id);
  return map;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);

  const dbUrl = requireEnv("SUPABASE_DB_URL");
  const apiKey = requireEnv("ORBIT_API_KEY");
  const apiBase = (process.env.ORBIT_API_URL_LOCAL ?? "http://localhost:3047/api/v1").replace(/\/$/, "");
  const selfPhone = process.env.ORBIT_SELF_PHONE && process.env.ORBIT_SELF_PHONE.trim()
    ? process.env.ORBIT_SELF_PHONE.trim()
    : FALLBACK_SELF_PHONE;
  const selfName = "Sanchay Thalnerkar"; // Matches existing card observations.

  console.error(`[init] api_base=${apiBase} self_phone=${selfPhone} dry_run=${args.dryRun} limit=${args.limit ?? "none"}`);

  const pool = new pg.Pool({ connectionString: dbUrl, max: 4 });

  // Discover user_id — there's only one founder on this DB per CLAUDE.md.
  const userRes = await pool.query(
    `SELECT DISTINCT user_id FROM raw_events WHERE source='whatsapp' LIMIT 2`,
  );
  if (userRes.rows.length !== 1) {
    console.error(`[fatal] expected 1 user_id, got ${userRes.rows.length}`);
    await pool.end();
    process.exit(2);
  }
  const userId = userRes.rows[0].user_id;
  console.error(`[init] user_id=${userId}`);

  // Build phone→person_id map.
  console.error(`[init] building resolver maps…`);
  const { phoneMap, emailMap, personCount } = await buildResolverMaps(pool, userId);
  console.error(
    `[init] resolver: ${personCount} persons · ${phoneMap.size} phone entries · ${emailMap.size} email entries`,
  );

  // Query raw_events (WhatsApp only for P1).
  console.error(`[init] loading raw_events (source=whatsapp)…`);
  const limitSql = args.limit ? `LIMIT ${args.limit}` : "";
  const evRes = await pool.query(
    `
    SELECT
      source_event_id,
      channel,
      occurred_at,
      direction,
      thread_id,
      participants_raw,
      participant_phones,
      body_preview,
      raw_ref
    FROM raw_events
    WHERE source = 'whatsapp'
      AND user_id = $1
    ORDER BY occurred_at ASC
    ${limitSql}
    `,
    [userId],
  );
  console.error(`[init] loaded ${evRes.rows.length} raw_events`);

  // Pre-plan: determine for each row whether we emit an interaction.
  const plans = [];
  const reasons = { group_msg: 0, no_phone: 0, no_msg_kind: 0, phone_not_normalizable: 0, self_phone: 0, unresolved_phone: 0 };
  for (const row of evRes.rows) {
    const plan = planFromRow({ row, phoneMap, selfPhone });
    if (plan.skip) {
      reasons[plan.reason] = (reasons[plan.reason] ?? 0) + 1;
      continue;
    }
    plans.push({ row, plan });
  }
  console.error(
    `[plan] ${plans.length} emit-able · skip: ${JSON.stringify(reasons)}`,
  );

  // ----- DRY RUN -----
  if (args.dryRun) {
    console.error(`[dry-run] printing first 10 unique-sender payloads…`);
    const seen = new Set();
    let printed = 0;
    for (const p of plans) {
      if (seen.has(p.plan.person_id)) continue;
      seen.add(p.plan.person_id);
      const obs = buildInteractionObservation({
        row: p.row,
        peerPhoneE164: p.plan.peer_phone,
        peerName: p.plan.peer_name,
        selfName,
      });
      const mergeObs = {
        kind: "merge",
        observed_at: obs.observed_at,
        observer: "wazowski",
        evidence_pointer: `interaction-link://wacli/source_event_id=${p.row.source_event_id}`,
        confidence: 1.0,
        reasoning: `Deterministic link of interaction observation to person_id=${p.plan.person_id} via phone bridge (${p.plan.peer_phone}).`.slice(0, 2000),
        payload: {
          person_id: p.plan.person_id,
          merged_observation_ids: ["<interaction-obs-id>", "<interaction-obs-id>"],
          deterministic_bridges: [`phone:${p.plan.peer_phone}`],
        },
      };
      console.log(JSON.stringify({ interaction: obs, merge: mergeObs }, null, 2));
      printed++;
      if (printed >= 10) break;
    }
    console.error(`[dry-run] printed ${printed} — done, no POSTs.`);
    await pool.end();
    return;
  }

  // ----- LIVE RUN -----
  // Feed ResilientWorker with "targets" = the plans. Each batch = up to 100
  // plans. processBatch handles: POST interactions → lookup IDs → POST
  // merges → return outputs (counts).

  const runId = `interaction-pipeline-${args.limit ? `limit-${args.limit}-` : ""}${new Date().toISOString().slice(0, 19).replace(/[:]/g, "-")}`;

  let totalInserted = 0;
  let totalDeduped = 0;
  let totalMergeInserted = 0;
  let totalMergeDeduped = 0;
  let totalMissingIds = 0;

  const worker = new ResilientWorker({
    runId,
    outDir: OUT_DIR,
    targets: plans,
    batchSize: 100,
    concurrency: 3,
    budget: { maxWallMin: 120 },
    retry: { maxAttempts: 3, backoffMs: [5000, 20000, 60000] },
    circuitBreaker: { failureRateThreshold: 0.4, window: 6 },
    classifyError: (err) => {
      // 400 is permanent; 5xx / network transient.
      if (err instanceof HttpError) {
        if (err.status === 400 || err.status === 401 || err.status === 403) return "PERMANENT";
      }
      return "TRANSIENT";
    },
    processBatch: async (batch, { index }) => {
      const interactions = [];
      const byPointer = new Map(); // evidence_pointer → { row, plan }
      for (const p of batch) {
        const obs = buildInteractionObservation({
          row: p.row,
          peerPhoneE164: p.plan.peer_phone,
          peerName: p.plan.peer_name,
          selfName,
        });
        interactions.push(obs);
        byPointer.set(obs.evidence_pointer, p);
      }

      // 1. POST interactions.
      const r1 = await postObservations(apiBase, apiKey, interactions);
      totalInserted += r1.inserted ?? 0;
      totalDeduped += r1.deduped ?? 0;

      // 2. Look up observation IDs for every evidence_pointer (includes
      // dedup'd ones — those already had IDs from a prior run).
      const idMap = await lookupObservationIds({
        pool,
        userId,
        evidencePointers: [...byPointer.keys()],
      });

      // 3. Build merge observations.
      const merges = [];
      let missing = 0;
      for (const [pointer, p] of byPointer) {
        const iid = idMap.get(pointer);
        if (!iid) {
          missing++;
          continue;
        }
        merges.push({
          kind: "merge",
          observed_at: new Date(p.row.occurred_at).toISOString(),
          observer: "wazowski",
          evidence_pointer: `interaction-link://wacli/source_event_id=${p.row.source_event_id}`,
          confidence: 1.0,
          reasoning: `Deterministic link of interaction observation ${iid} to person_id=${p.plan.person_id} via phone bridge (${p.plan.peer_phone}). Auto-emitted by build-interactions-from-raw-events.mjs.`.slice(0, 2000),
          payload: {
            person_id: p.plan.person_id,
            // min(2) workaround — see memory/tech_merge_min2_workaround.md
            merged_observation_ids: [iid, iid],
            deterministic_bridges: [`phone:${p.plan.peer_phone}`],
          },
        });
      }
      totalMissingIds += missing;

      // 4. POST merges (batches of up to 100 fit in one call).
      if (merges.length > 0) {
        const r2 = await postObservations(apiBase, apiKey, merges);
        totalMergeInserted += r2.inserted ?? 0;
        totalMergeDeduped += r2.deduped ?? 0;
      }

      return {
        ok: true,
        outputs: merges.map((m) => ({
          person_id: m.payload.person_id,
          evidence_pointer: m.evidence_pointer,
        })),
      };
    },
  });

  const result = await worker.run();

  const summary = {
    run_id: runId,
    phase: result.phase,
    batches_total: worker.batches.length,
    batches_completed: result.completedBatches,
    batches_quarantined: result.quarantined,
    plans_total: plans.length,
    raw_events_scanned: evRes.rows.length,
    skip_reasons: reasons,
    interactions_inserted: totalInserted,
    interactions_deduped: totalDeduped,
    merges_inserted: totalMergeInserted,
    merges_deduped: totalMergeDeduped,
    missing_ids_after_post: totalMissingIds,
    wall_minutes: result.wallMinutes,
  };
  writeFileSync(
    resolve(OUT_DIR, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  console.log(JSON.stringify(summary, null, 2));

  await pool.end();
  if (result.phase !== "done") process.exit(1);
}

main().catch((err) => {
  console.error(`[fatal] ${err?.stack ?? err?.message ?? err}`);
  process.exit(1);
});
