# Audit 5 — Phase 5 "Living Loop" liveness

**Date:** 2026-04-21 06:31 UTC
**Auditor:** claude-opus-4-7 (Task 5 of 6)
**Audit-only.** No data modified.

---

## Verdict

**PARTIAL.** The plumbing is wired end-to-end and ticking on schedule — pg_cron fires, jobs land in the queue, claw's systemd timer claims and dispatches, the /claim and /report routes both return correct HTTP. But **every job that claw has dispatched since the loop went live has ended in `status=failed`**, and there is **no automatic orphan reaper** — the two orphan rows observed in history were cleared by a manual SQL update, not by any scheduled job or DB trigger.

---

## Layer-by-layer state

### 1. pg_cron schedules (Supabase)

| jobname | schedule | active | jobid | last fire (UTC) | time-since | fires in last 24h |
|---|---|---|---|---|---|---|
| `orbit-observer-tick` | `*/15 * * * *` | ✅ | 1 | 2026-04-21 06:15:00 | 13m | 2 |
| `orbit-meeting-sync-tick` | `0 * * * *` | ✅ | 2 | 2026-04-21 06:00:00 | 28m | 1 |
| `orbit-enricher-tick` | `0 3 1,15 * *` | ✅ | 3 | (never) | — | 0 |

Observer is on its expected 15-min cadence (next fire 06:30); meeting-sync is on its hourly cadence (next fire 07:00); enricher is bi-monthly (next fire 2026-05-01 03:00) so zero fires in 24h is expected.

`cron.job_run_details` contains only 3 rows for orbit-* jobs in the last 24h — all at or after 06:00 today. The cron was installed very recently (today).

### 2. Jobs queue state

```
kind          total  claimed  done  succeeded  failed
meeting_sync      2        2     2          0       2
observer          2        2     2          1       1
```

No stuck jobs right now. The earliest observer (`e5ea6317…`, 05:52 UTC) is the manual phase-5 verification Sanchay ran — it succeeded in 2 seconds with 42 observations emitted. **Every job after that has failed.**

### 3. Claw systemd timer

- **Unit:** `orbit-job-runner.timer` — `OnUnitActiveSec=15min`, `Persistent=true`.
- **State:** active (waiting) since 05:56:57 UTC.
- **Last fire:** Tue 2026-04-21 06:14:41 UTC (completed at 06:18:00).
- **Next fire:** Tue 2026-04-21 06:29:41 UTC (in ~2min from audit time).

Service history from `journalctl --user -u orbit-job-runner.service`:

| Time (UTC) | Result | Notes |
|---|---|---|
| 05:56:57 | **failed** — `Failed to load environment files` | Env file `/home/sanchay/.orbit/env` wasn't readable at that moment |
| 06:01:16 | **failed** — `status=216/GROUP` | `Failed to determine supplementary groups: Operation not permitted` |
| 06:07:02 → 06:12:02 | **timed out** — `TimeoutStartSec=300` hit, SIGTERM | Dispatched meeting_sync, openclaw hung past 5-min limit → orphan |
| 06:14:41 → 06:18:00 | **ok (reported)** — but job `status=failed` | openclaw agent ran ~3.3 min and returned a 400 error |

### 4. Dispatcher state on claw

All four dispatchers are present + executable under `~/orbit-job-runner/dispatchers/`:

```
-rwxr-xr-x  enricher.sh         # invokes /home/sanchay/orbit/scripts/enricher-v5-haiku.mjs
-rwxr-xr-x  meeting_sync.sh     # openclaw agent --agent main --message ...
-rwxr-xr-x  observer.sh         # openclaw agent --agent main --message ...
-rwxr-xr-x  topic_resonance.sh  # openclaw agent --agent main --message ...
```

All use the correct invocation shape (`openclaw agent --agent main --message ...`), not the obsolete `openclaw run --skill` shape. Good.

### 5. Route liveness probe

Routing note: claw's `ORBIT_API_URL=http://100.97.152.84:3047/api/v1` (Tailnet → Mac dev server). The public `orbit-mu-roan.vercel.app` is 404 as designed — deployment was torn down on 2026-04-19.

Against the live dev URL:

| Probe | Expected | Actual |
|---|---|---|
| `POST /api/v1/jobs/claim` with empty queue | 200 `{job:null}` | ✅ 200 `{"job":null}` |
| `POST /api/v1/jobs/report` with bogus uuid | 404 `not_found` | ✅ 404 `{"error":{"code":"not_found"}}` |

Both endpoints are behaving per their Zod schemas + RPC contract.

---

## The actual failure modes (root cause)

**meeting_sync job `9a9915e4…`** (06:14:43 → 06:18:00):

Result payload includes a verbatim stderr from `openclaw agent`. Two failure chains observed in sequence:

1. Opus-4.6 rejected the request: `messages.69.content.1: 'thinking' or 'redacted_thinking' blocks in the latest assistant message cannot be modified.` → fallback triggered.
2. Opus-4.7 rejected: `"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort"...` → retried with thinking=off → eventual `Error: session file locked (timeout 10000ms): pid=290206 /home/sanchay/.openclaw/agents/main/sessions/sessions.json.lock`.

So the dispatcher itself ran fine — it's the openclaw `main` agent that's wedged on (a) a persisted thinking-block in its session history that Anthropic rejects, plus (b) a stale session lock. The skill never starts.

**meeting_sync job `6eb2c2ea…`** and **observer job `d444b553…`** both show result:

```json
{"status":"failed","data":{"reason":"orphaned by service timeout - handler did not report back"}}
```

with `completed_at = 2026-04-21 06:13:51.518742+00` for *both* (identical to the microsecond). There is **no function, trigger, or cron job in Postgres that produces this string**, and `grep -r "orphan\|did not report"` finds nothing in the codebase. **This was a manual `UPDATE jobs SET result = …` executed by someone** (probably Sanchay from the earlier verification session) to unstick the queue. The loop did not self-heal.

### Stuck-job detection right now

```sql
SELECT id, kind, claimed_at, NOW() - claimed_at AS stuck_for
FROM jobs
WHERE claimed_at IS NOT NULL AND completed_at IS NULL
ORDER BY claimed_at DESC;
-- → 0 rows (as of 06:31 UTC)
```

No currently-stuck jobs, but only because the last tick (06:14→06:18) did report back (as failed), and the prior two orphans were manually closed at 06:13:51.

---

## Timeline — last ~24h

```
05:52:06  manual enqueue: observer e5ea6317 (verification seed)
05:52:17  claw claims observer e5ea6317
05:52:19  claw reports succeeded (42 observations emitted)
05:56:57  systemd.timer: first tick → service FAIL (env file not loaded)
06:00:00  pg_cron orbit-observer-tick → enqueue observer d444b553
06:00:00  pg_cron orbit-meeting-sync-tick → enqueue meeting_sync 6eb2c2ea
06:01:16  systemd tick → service FAIL (GROUP permission)
06:01:26  systemd tick → claims observer d444b553 → dispatcher started
          (no "reported" log — orphaned)
06:07:02  systemd tick → claims meeting_sync 6eb2c2ea → dispatcher started
          (no "reported" log — orphaned)
06:12:02  systemd timeout (TimeoutStartSec=300) → SIGTERM on tick 06:07
06:13:51  *** MANUAL SQL UPDATE *** closes both orphans with
          {"reason":"orphaned by service timeout - handler did not report back"}
06:14:41  systemd tick → claims meeting_sync 9a9915e4 → dispatcher started
06:15:00  pg_cron orbit-observer-tick → runs fn, no new raw_events → 0 jobs enqueued
06:18:00  systemd tick finishes → reports 9a9915e4 as FAILED
          (openclaw agent crash: thinking-block + session lock)
06:29:41  next scheduled tick (empty queue expected; observer-tick watermark advanced)
```

---

## Blockers

1. **OpenClaw `main` agent is wedged.** Every dispatcher call goes through `openclaw agent --agent main --message ...`. The agent's persisted session carries an assistant message with a `thinking` block that Anthropic now rejects on replay. Until the session is reset (or the SKILL starts a fresh conversation per invocation), every observer/meeting_sync/topic_resonance tick will fail the same way.

2. **No orphan reaper exists.** If the dispatcher hangs past `TimeoutStartSec=300`, systemd SIGTERMs the whole tick — `run-once.sh` never reaches its `/jobs/report` call. The row stays `claimed_at IS NOT NULL, completed_at IS NULL` forever. The two such rows from 06:00 were cleared by a manual UPDATE at 06:13:51 — not by any scheduled mechanism.

3. **systemd service timeout (5 min) is shorter than openclaw's dispatcher timeout (1200 s / 20 min).** The dispatcher scripts invoke openclaw with `--timeout 1200`, but systemd kills the whole tick at 300s. That means any skill run longer than 5 minutes is guaranteed to orphan its job.

4. **`cron_enqueue_observer_ticks` is gated by `raw_events.ingested_at > watermark`.** The 06:15 observer tick ran the function (1 row returned) but didn't enqueue a job — no new raw_events since 06:00. Fine for now, but worth noting: without fresh ingestion the observer side of the loop idles.

---

## Recommendation — ship the orphan-reaper

Minimum viable reaper, one new Postgres function + one new pg_cron schedule:

```sql
CREATE OR REPLACE FUNCTION public.reap_orphan_jobs(p_stuck_after interval DEFAULT interval '20 minutes')
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_count integer;
BEGIN
  UPDATE public.jobs
     SET completed_at = now(),
         result = jsonb_build_object(
           'status','failed',
           'data', jsonb_build_object(
             'reason','orphaned by service timeout - handler did not report back',
             'claimed_at', claimed_at,
             'claimed_by', claimed_by,
             'stuck_for_sec', extract(epoch from (now() - claimed_at))::int
           )
         )
   WHERE claimed_at IS NOT NULL
     AND completed_at IS NULL
     AND claimed_at < now() - p_stuck_after;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END; $$;

SELECT cron.schedule(
  'orbit-reap-orphans',
  '*/5 * * * *',
  $$ SELECT public.reap_orphan_jobs(interval '20 minutes'); $$
);
```

**Why 20 min:** longer than the 5-min systemd TimeoutStartSec plus the next 15-min tick's grace window, so legitimate slow runs aren't falsely reaped.

**Separately, fix the root cause (NOT part of this audit, but flagging):**

- Bump `TimeoutStartSec` in `~/.config/systemd/user/orbit-job-runner.service` from 300 to at least 1500 (> the `openclaw agent --timeout 1200` cap) so successful long runs actually get to report. Reaper stays as the safety net.
- Reset or shard the openclaw `main` agent session so the stuck `thinking` block stops replaying. Or have the dispatcher invoke a disposable per-tick agent rather than reusing `main`.

These are behind Sanchay's explicit-go gate per CLAUDE.md — audit-only pass, no fixes applied.

---

## Artifacts

- `cron.job` snapshot: see §1 table above.
- `cron.job_run_details` (last 24h, orbit-*): 3 rows, all succeeded.
- `jobs` snapshot: 4 rows (1 succeeded, 3 failed; 2 of those 3 were manual-reaped orphans).
- claw journalctl tail: 4 service runs — 2 env/group failures, 1 timeout/orphan, 1 reported-failed.
- Dispatcher files: all 4 present, executable, using correct `openclaw agent --agent main --message` shape.
- Route probes: `/jobs/claim` → 200 `{job:null}`; `/jobs/report` → 404 `not_found` on bogus uuid.
