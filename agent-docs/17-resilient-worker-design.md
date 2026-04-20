# 17 · Resilient Worker — design for a shared batch-job library

> **STATUS: design-only, not yet built.** Proposed as the prerequisite for Stage 7 (continuous loop) because a cron that silently fails or stalls kills the "living map" promise. Captures the lessons from Stage 6-v1 stall + Stage 6-v3 JSON-parse-loss in one reusable module.

## The pitch in one paragraph

Every long-running batch job we've built this session (enricher-v3, enricher-v4, bulk-ingest, observer-dispatcher) re-implements the same plumbing badly: progress tracking, retry logic, error handling, cost+time budgets. Build it **once** as `scripts/lib/resilient-worker.mjs`. Every future caller imports it instead of rebuilding. Three guarantees: **(1)** a crash loses at most one batch of work, **(2)** every batch logs an ETA so the user never wonders "is this frozen?", **(3)** circuit breaker stops the run before it burns money on a pathological failure.

## What the module handles (so callers don't have to)

| Concern | Primitive | Where the data lives |
|---|---|---|
| **Resumability** | Progress file — atomic write after each batch | `outputs/<run>/progress.json` |
| **Transient-failure recovery** | Retry with exponential backoff (5s / 20s / 60s) | in-memory |
| **Permanent-failure isolation** | Dead-letter queue — moved aside, not retried, not blocking | `outputs/<run>/quarantine.ndjson` |
| **Pathological-run detection** | Circuit breaker — halts if >30% batches fail in last 5 | in-memory + log |
| **Time forecasting** | Rolling EMA over last-N batch durations | progress file + stdout |
| **Budget enforcement** | $ + wall-clock ceilings (stop when crossed) | progress file + stdout |
| **Structured logging** | Per-batch one-liner with phase, elapsed, ETA, cost | stdout + run.log |

## Concrete run (enricher-v5 walkthrough, 1,500 persons / 50 batches)

### Normal path

```
[batch 1/50  ✓ 2.8s · 30 enriched · avg 2.8s · ETA ~2m 20s · $0.06]
[batch 2/50  ✓ 3.1s · 30 enriched · avg 2.95s · ETA ~2m 20s · $0.12]
...
[batch 50/50 ✓ DONE · 1,500 enriched · elapsed 4m 47s · cost $3.20]
```

`progress.json` updated atomically after each batch. `tail -f` it and the ETA drops in real time.

### Transient network hiccup

```
[batch 12/50 ⚠ network timeout — retrying in 5s (attempt 2/3)]
[batch 12/50 ✓ 4.8s (after 1 retry) · 30 enriched]
```
Self-heals. No human involvement.

### Permanent batch failure (same class as Stage 6-v3's JSON parse error)

```
[batch 32/50 ✗ JSON parse error — retrying in 5s  (attempt 2/3)]
[batch 32/50 ✗ JSON parse error — retrying in 20s (attempt 3/3)]
[batch 32/50 ✗ ALL RETRIES FAILED → quarantined, continuing]
```
Batch 32's 30 persons land in `quarantine.ndjson`. The other 49 batches finish. **No more losing 30 to one bad batch.**

### Process crash (laptop closes, OOM, Ctrl-C)

Next run:
```
$ node scripts/enricher-v5.mjs --resume
[Reading outputs/enricher-v5-2026-04-21/progress.json...]
[Resuming at batch 32 (31/50 complete, $1.92 spent so far)]
[batch 32/50 starting...]
```
Picks up where it stopped. Dedup_key at the DB catches any accidental re-emission.

### Circuit breaker trips

```
[CIRCUIT_BREAKER: 5 consecutive batches failed. Halting.]
[Completed: 15/50 · 450 persons · cost $1.20]
[Failed batches in quarantine.ndjson — investigate before resuming]
```
Stops burning money. Human investigates root cause. Resume when ready.

## API surface the caller writes against

```js
import { ResilientWorker } from './lib/resilient-worker.mjs';

const worker = new ResilientWorker({
  runId: 'enricher-v5-2026-04-21',
  outDir: 'outputs/enricher-v5-2026-04-21/',
  targets: skeletonPersonIds,      // array of work items
  batchSize: 30,
  concurrency: 5,

  async processBatch(items) {       // ← caller's logic: do the work for this batch
    const contexts = await gatherContexts(items);
    const enrichments = await anthropicBatch(contexts);
    return { ok: true, outputs: enrichments.map(toObservation) };
  },

  async emitBatch(outputs) {        // ← caller's logic: persist / POST / write
    for (const o of outputs) fs.appendFileSync(outFile, JSON.stringify(o) + '\n');
    await orbitObservationBulk({ file_path: outFile });
  },

  retry: { maxAttempts: 3, backoffMs: [5000, 20000, 60000] },
  circuitBreaker: { failureRateThreshold: 0.3, window: 5 },
  budget: { maxCostUSD: 8, maxWallMin: 30 },
  costPerBatch: 0.06,              // estimated; used for ETA + ceiling

  classifyError(err) {
    if (err.code === 'ECONNRESET' || err.status >= 500) return 'TRANSIENT';
    if (err.code === 'JSON_PARSE' || err.status === 400) return 'PERMANENT';
    return 'TRANSIENT';  // default
  },
});

const result = await worker.run();
console.log(result);
// → { completed: 1500, failed: 0, quarantined: 0, cost: 3.20, wallMinutes: 4.8 }
```

The library handles:
- `progress.json` writes (atomic, after each batch)
- `--resume` logic (read progress, skip completed, continue from cursor)
- Retry backoff between attempts
- Circuit breaker state machine
- ETA math (rolling EMA of last 5 batches)
- Budget enforcement (costs + wall clock)
- Structured logging
- Quarantine file writes

Caller writes: `processBatch`, `emitBatch`, `classifyError`. That's it.

## Progress file schema

```json
{
  "run_id": "enricher-v5-2026-04-21",
  "phase": "running",
  "started_at": "2026-04-21T09:00:00Z",
  "last_checkpoint_at": "2026-04-21T09:03:42Z",
  "total_batches": 50,
  "completed_batches": 34,
  "quarantined_batches": [
    { "index": 32, "items": 30, "error": "JSON parse error", "attempts": 3 }
  ],
  "failed_consecutive": 0,
  "cursor": "<first item id of batch 35>",
  "cost_usd_so_far": 1.92,
  "elapsed_ms": 220000,
  "eta_ms_remaining": 110000,
  "budget": { "maxCostUSD": 8, "maxWallMin": 30 },
  "circuit_breaker_tripped": false
}
```

Single JSON file. Human-readable. `jq` it any time. Used by the library for resume, by the user for "how's it going?", by the watchdog for stall detection.

## Success criteria (measurable)

1. **Max data loss from crash: 1 batch.** Everything up to the last-checkpoint batch is preserved.
2. **Every batch emits a progress log line with ETA.** User never wonders "is this frozen?"
3. **Healthy-run failure rate < 5%.** Quarantine count surfaces any degradation loudly.
4. **`--resume` works.** Re-running after a crash picks up at the next unfinished batch with zero duplicate writes (DB dedup_key as last-line defense).
5. **Circuit breaker trips within 5 consecutive bad batches.** Pathological runs don't burn budget.
6. **One library, multiple callers.** Enricher + observer-dispatcher + bulk-ingest + future resolver all import the same module. No per-caller resilience re-implementation.
7. **Unit tests** covering: resume from mid-run progress file, retry-then-succeed, retry-then-DLQ, circuit-breaker trip, budget cap hit, concurrent batch failures.

## Why Stage 7 absolutely needs this

Stage 7 = continuous loop: `cron every 15 min` scans for new WA/Gmail → fires observer on new senders → updates cards.

Without the resilient-worker:
- Cron silently fails at 3am → founder loses a day of signal → "living map" freezes
- One bad message blows up one observer run → loses the 30 humans in that batch
- No visibility into "how's it going?" — cron is a black box
- No way to pause/resume — if the founder closes the laptop mid-run, progress is lost

With it:
- Every cron run logs structured output
- Quarantine catches bad inputs
- Resume handles laptop closures
- Circuit breaker halts runaway runs
- Single library, tested once

## Integration roadmap (when we build it)

1. **Build library** (~2-3 hours): core class, unit tests (10+), integration test with a fake batch function
2. **Retrofit enricher-v5** to use it — one flag away from the real v5 being resumable
3. **Write observer-dispatcher** on top of it — the Stage-7 cron caller
4. **Retrofit bulk-ingest + resolver** — same pattern everywhere

## Related

- [15-future-props.md](./15-future-props.md) — "Better code" section mentions this; promote there when built
- `memory/project_tracked_debt_2026_04_20.md` — tracks this implicitly as "resilience primitives not shipped"
- Stage 6-v3 report (`outputs/stage-6-v3-2026-04-20/report.md`) — the 30-person JSON-parse loss that motivated this
- Stage 6 (killed) task log — the 5-min/person stall that motivated resumability
