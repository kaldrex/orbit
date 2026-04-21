---
name: orbit-observer-backfill
description: First-run data-seeding pass for a newly onboarded founder. Reads local wacli snapshots on claw, POSTs raw_events + lid bridge, then projects interactions — no SSH, no direct DB, no Anthropic key.
metadata: {"openclaw":{"emoji":"🌱"}}
---

# orbit-observer-backfill

## When to use

- First run on a freshly installed OpenClaw on a new founder's machine, when Orbit's observation basket is empty for this `user_id`.
- Sanchay says "re-seed the ledger from wacli" or "bootstrap Orbit for a new founder".
- Invoked by the observer dispatcher in `orbit-job-runner` when first-run is detected (see §Detection below).

## When NOT to use

- On a founder whose basket already has observations — this is seeding, not incremental. Running it when raw_events are already ingested is safe (idempotent on `(user_id, source, source_event_id)`) but wastes a cycle. Check first.
- Without a readable `~/.wacli/wacli.db` on claw — a fresh wacli login is a prerequisite. If the snapshot is missing, abort with `reason: "no_wacli_snapshot"`.
- To do any LLM work. This is pure plumbing. Enrichment / resolution / topic extraction are separate SKILLs run AFTER this one.

## Safety

- Read-only on `~/.wacli/wacli.db`, `~/.wacli/session.db` — never writes to them.
- Every write goes through the orbit-cli plugin verbs (HTTP API). Never bypasses to Postgres. CLAUDE.md §6: "API is the only writer".
- No `ANTHROPIC_API_KEY` usage. If you catch yourself drafting an Anthropic call in this SKILL, stop — it belongs in `orbit-enricher` / `orbit-resolver` / `orbit-topic-resonance`, which run AFTER backfill.
- Budget ceiling: $0 (no LLM tokens spent here). Wall-clock ceiling: ~15 min for a typical 33k-row wacli snapshot.

## Your tools

From the `orbit-cli` plugin — pure plumbing, no judgment:

1. `orbit_raw_events_backfill_from_wacli({wacli_db?, batch_size?, dry_run?})` — reads local `~/.wacli/wacli.db`, POSTs to `/api/v1/raw_events` in batches of 500. Idempotent.
2. `orbit_lid_bridge_ingest({session_db?, batch_size?})` — reads local `~/.wacli/session.db` `whatsmeow_lid_map`, POSTs to `/api/v1/lid_bridge/upsert` in batches of 500. Idempotent.
3. `orbit_interactions_backfill({source?, limit?, batch_size?, self_name?, dry_run?})` — paginates `GET /api/v1/raw_events?source=whatsapp`, projects each row into a `kind:"interaction"` observation, POSTs to `/api/v1/observations`. Server dedupes on `dedup_key`.

Optional downstream (NOT this SKILL's job, but the dispatcher chains them):

- `orbit-resolver` SKILL — deterministic merges via phone/email bridges, emits `kind:"merge"`.
- `orbit-observer` SKILL — per-seed scan for `kind:"person"` observations (Sanchay runs this per-human, not as bulk).

## Order of operations

Run these three verbs **in order**. Each MUST succeed before the next starts; on any failure, log and abort.

### 1. Raw events backfill

```
orbit_raw_events_backfill_from_wacli({})
```

Expected return: `{ok: true, batches_posted: N, total_rows: ~33000, total_inserted: ~33000, total_updated: 0, failed_batches: []}`.

On first run, `total_inserted ≈ total_rows`. On re-runs, `total_updated` may be non-zero if a row's preview/connector_version changed, but `total_inserted + total_updated == total_rows` always holds.

If `failed_batches.length > 0` — abort. Do NOT proceed to step 2 with a partial ledger.

### 2. LID bridge ingest

```
orbit_lid_bridge_ingest({})
```

Expected return: `{ok: true, rows_dumped: ~5000, batches_posted: N, total_upserted: ~5000, failed_batches: []}`.

This seeds the `lid_phone_bridge` table so downstream graph/resolver work can map `@lid`-only group senders back to phones.

If `failed_batches.length > 0` — log, continue. Missing LIDs degrade group-message attribution but don't block interactions.

### 3. Interactions backfill

```
orbit_interactions_backfill({})
```

Expected return: `{ok: true, pages_scanned: N, rows_scanned: ~33000, observations_posted: K, total_inserted: K, total_deduped: 0, failed_batches: []}`.

Note: `K < rows_scanned` because group-kind rows and phoneless rows are skipped (the projection drops rows it can't attribute — the resolver SKILL handles group-participant attribution later).

On re-runs, `total_deduped ≈ observations_posted` — that's expected (server dedupes on `evidence_pointer`).

## First-run detection (for the observer dispatcher)

The dispatcher calls this SKILL before `orbit-observer` if the founder is new. Two signals the dispatcher checks:

1. `GET /api/v1/observations?limit=1` returns `{observations: []}` — an empty basket = first run.
2. Absence of a `capability_reports` row whose `data_sources.whatsappHistory == true` — the observer-backfill flips this on success.

Either signal alone is enough. The dispatcher always prefers the observations check (it's cheaper and the RPC never lies).

## Final log line

Print exactly one line on exit:

```
backfill status=ok raw_events=<N> lid_bridge=<M> interactions=<K> skipped=<rows_scanned-K> elapsed=<sec>s
```

Or on failure:

```
backfill status=failed stage=<raw_events|lid_bridge|interactions> reason=<short_reason>
```

## Example (Sanchay's first run, approx numbers)

Input: Sanchay installs OpenClaw on Wazowski, pairs wacli, runs the observer dispatcher for the first time.

Detection: basket empty → dispatcher invokes `orbit-observer-backfill`.

Output:

- `orbit_raw_events_backfill_from_wacli`: 66 batches of 500 × 2 = ~33,000 rows inserted in ~12s.
- `orbit_lid_bridge_ingest`: 10 batches of 500 = ~5,000 LID rows upserted in ~2s.
- `orbit_interactions_backfill`: ~200 pages of 500 = ~33,000 rows scanned, ~18,000 interactions posted (the rest are groups or phoneless).

Log line:

```
backfill status=ok raw_events=33054 lid_bridge=4982 interactions=18112 skipped=14942 elapsed=47s
```

After this, the dispatcher moves on to `orbit-resolver` (if present) and then the normal `orbit-observer` run.

## Failure modes

- `orbit_raw_events_backfill_from_wacli` returns `{error:{code:"FILE_NOT_FOUND"}}` — wacli hasn't snapshotted yet. Abort. Ask the founder to `wacli login` and retry.
- Any CLI verb returns `{error:{code:"AUTH_FAILED"}}` — `ORBIT_API_KEY` is missing/wrong on claw. Abort, surface the exact error. Don't retry.
- Any verb returns a `failed_batches[]` entry with `http_status: 5xx` — log-first, retry-never (CLAUDE.md §5). Abort. Operator inspects server logs before re-running.
- Wall budget exceeded — abort with partial progress. Re-running is safe (idempotent).
