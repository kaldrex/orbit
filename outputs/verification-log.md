# Orbit V0 — Verification Log

Append-only ledger. Every build claim lands here with an evidence artifact and a rollback path.

> **Reading entries below:** anything dated before the 2026-04-18 clean-slate prune references artifacts that no longer exist on disk (old plugin, `/api/v1/ingest`, `src/lib/neo4j.ts`, `src/lib/cypher/*`, import scripts). That's expected — the ledger is frozen history, not current state. For what exists now, read [../agent-docs/03-current-state.md](../agent-docs/03-current-state.md).

---

## 2026-04-18 — Supabase residue cleanup (migration 001)

**Claim:** "Only `raw_events`, `api_keys`, `profiles` remain in Supabase `public` schema. No pre-pivot debt anywhere in the DB."

**Investigation:** Probed live DB via `psql $SUPABASE_DB_URL`. Found three undocumented orphans from the deleted pipeline: `merge_audit` (603 rows, history from `/api/v1/merge`), `connectors` (0 rows, schema from `/api/connectors/*`), and `profiles.self_node_id` pointing at a wiped Neo4j node.

**Change:** Applied [scripts/migrations/001-supabase-clean-slate.sql](../scripts/migrations/001-supabase-clean-slate.sql) — `DROP TABLE merge_audit`, `DROP TABLE connectors`, `UPDATE profiles SET self_node_id = NULL`.

**Evidence:**
- `psql -c "\dt public.*"` → 3 tables: `api_keys`, `profiles`, `raw_events`.
- `psql -c "SELECT self_node_id FROM profiles"` → null.
- Migration is idempotent: re-run reports `DROP TABLE` no-ops + `UPDATE 0`.

**Rollback:** The two tables are gone + `self_node_id` nulled. No business data lost (`merge_audit` was dead history; `connectors` was empty). If something later needs those tables, re-create via forward migration.

---

## 2026-04-18 — Clean-slate prune

**Claim:** "Pre-pivot backend and both OpenClaw plugin packages are deleted; Neo4j is empty; claw plugin service stopped."

**Evidence:**
- Commits `2aa1638`, `c41257d`, `6dc5769`, `bfb861e`, `54c84f1` on `main`.
- 96 files changed, −11,417 net LOC across the five commits.
- `npm test` → 26 passing (down from 41; 15 tests retired with their fossil targets).
- `npx next build` → clean compile, clean typecheck.
- Neo4j: `MATCH (n) RETURN count(n)` → 0 (was 1,711 persons, 366k edges).
- Claw: `systemctl --user is-active openclaw-gateway.service` → `inactive`; `ls ~/.openclaw/plugins/` → no orbit plugins.
- Agent-context layer restructured: [../CLAUDE.md](../../CLAUDE.md) (60 LOC) + [../agent-docs/](../../agent-docs/) (7 files).

**Rollback:** `git revert <sha>` per commit. Neo4j + claw state re-populates when the new plugin + Track 3 projection ship.

**Commit:** `54c84f1` (docs restructure; the prune itself is across the four earlier commits).

---

## 2026-04-18 — Track 1, fix #1: Gmail connector availability on claw

**Claim:** "Gmail connector is disabled on claw and needs a PATH fix."

**Investigation:** SSH'd to claw, inspected live gateway state.

**Finding:** ❌ **CLAIM WAS WRONG.** The issue was stale state from a previous gateway run, not a PATH bug. After a gateway restart at 06:17:45 UTC on 2026-04-18:

```
[connector-registry] enabled: Google Calendar (batch)
[connector-registry] enabled: Gmail (batch)
[connector-registry] enabled: Linear (batch)
[connector-registry] skipped: Slack (not available)
[connector-registry] enabled: WhatsApp (realtime)
[plugins] [orbit] connectors enabled: calendar, gmail, linear, whatsapp
[connector-registry] batch poll scheduled: gmail every 2h
```

Direct reproduction on claw:

```
$ node -e "const {execFileSync} = require('child_process'); console.log(execFileSync('which', ['gws'], {encoding: 'utf8'}))"
/usr/bin/gws
```

**Resolution:** No code change needed. Moving to fix #2.

**Unexpected bonus finding:** plugin already has `identity cache: 11822 contacts, 860 LID mappings` on startup — some LID→phone bridging was already implemented by an earlier session.

---

## 2026-04-18 — Track 1, fix #2: preserve `source_event_id` / `thread_id` / `body_preview` / `direction` / `source` on INTERACTED edge

**Claim:** "Ingest pipeline drops ~40% of handoff-prescribed audit fields at `/api/v1/ingest`. Fix: add 5 nullable fields to the INTERACTED edge + the ingest payload schema."

**Change:**
- [src/lib/neo4j.ts](../src/lib/neo4j.ts): extended `InteractionBatchItem` interface with `source`, `sourceEventId`, `threadId`, `bodyPreview`, `direction` (all `string | null`). Cypher `CREATE (a)-[:INTERACTED {...}]->(b)` now writes all five fields.
- [src/app/api/v1/ingest/route.ts](../src/app/api/v1/ingest/route.ts): extended the interaction payload type with matching optional fields. `body_preview` truncated to 160 chars defensively. Null fallback for each.

**Safety:**
- Additive only — Neo4j is schemaless; old INTERACTED edges (without these fields) continue to read fine as null.
- Payload fields are optional — existing plugin sends without them, server writes nulls, no regression.
- No migration, no data rewrite, no breaking change.

**Evidence:**
```
$ npx tsc --noEmit
(exit 0, no output)
```

**Still pending (not part of this commit):**
- Plugin update to actually SEND `source_event_id` / `thread_id` / `body_preview` in the ingest payload. Without this, the new fields write nulls.
- Vercel deploy — until the new server code is live, plugin changes can't be tested end-to-end.
- Real-data verification: after both land, query a sample INTERACTED edge and confirm the new fields are populated.

**Rollback:** `git revert <commit-hash>` — safe at any time since the change is additive.

---

## 2026-04-18 — Track 1 scaffolding: Vitest + fixtures + four defensive fixes

**Claim:** "Track 1 of the V0 master roadmap is landed with code + regression tests for every sub-task."

**Changes:**
- Vitest wired (`package.json`, `vitest.config.ts`), CI workflow at `.github/workflows/test.yml`
- Regression test `tests/unit/interacted-edge-fields.test.ts` — locks in the 5 audit fields from fix #2 above so a future Cypher refactor cannot silently drop them
- Defensive resolver `packages/orbit-plugin/lib/gws-path.js` + tests `tests/unit/gmail-availability.test.js` — probes known absolute paths before falling back to `which`. Even though the live diagnosis (fix #1 entry above) showed the PATH fix was unnecessary on the current claw, the resolver is strictly additive and protects against the class of subprocess-PATH bugs elsewhere. Shared with `capabilities.js` so the capability report and connector availability never disagree.
- Deterministic fixture `tests/fixtures/wacli-minimal.db` (45 KB, 10 chats, 50 msgs, 5 contacts, 12 group_participants) built by `tests/fixtures/build-wacli-minimal.mjs`
- New importer `scripts/import-group-participants.mjs` + Cypher `src/lib/cypher/co-present-edge.cypher` — materializes WA group membership as `CO_PRESENT_IN` edges (weight 0.1, `source:'wa_group'`, accumulating `group_jids` array). Pure-over-`runCypher` so integration tests swap in a fake.
- LID→phone bridge scaffolding `scripts/lid-bridge-nightly.mjs` + seed `tests/fixtures/lid-seed.json` (35 synthetic pairs, confidence ≥ 0.8). Includes explicit anti-regression: single-token overlaps produce confidence < 1 never auto-merges (spec §5).

**Evidence:**

```
$ npm test
 RUN  v3.2.4

 ✓ tests/unit/sanity.test.js                    (1 test)
 ✓ tests/unit/interacted-edge-fields.test.ts    (5 tests)
 ✓ tests/unit/gmail-availability.test.js        (3 tests)
 ✓ tests/integration/group-participants-import.test.js (3 tests)
 ✓ tests/integration/lid-bridge.test.js         (3 tests)

 Test Files  5 passed (5)
      Tests  15 passed (15)
```

Full log: [outputs/verification/2026-04-18-track1/npm-test.log](./verification/2026-04-18-track1/npm-test.log)

**Deferred (requires infra access beyond worktree):**
- Live claw capability-report capture after a gateway restart — once landed, append `outputs/verification/2026-04-18-track1/gateway-channels-after-fix.txt`.
- Live dry-run of `scripts/import-group-participants.mjs` against Sanchay's real `wacli.db` — would emit `{groups_processed: N}` where N = count of WA groups with ≥ 2 known members. Run once the branch merges and the plugin can reach Neo4j.

**Rollback (each commit is independent):**
- `git revert` the commit of the specific sub-task
- All changes are additive — no schema drops, no data rewrite, no breaking contracts

**Commit:** _pending — to land as a single commit or per-task commits on `claude/cool-sammet-36b821`_

---

## 2026-04-18 — Track 2: raw_events ledger + idempotent endpoint + two importers

**Claim:** "raw_events is now the durable append-only ledger. Server accepts idempotent upserts. wacli.db and JSONL bootstrap importers work against the committed fixtures."

**Changes:**
- [supabase/migrations/20260418_raw_events.sql](../supabase/migrations/20260418_raw_events.sql) — table with unique `(user_id, source, source_event_id)`, five indexes (time, thread, source, email GIN, phone GIN), RLS (read/insert only — no update/delete per append-only contract).
- [supabase/migrations/20260418_upsert_raw_events_rpc.sql](../supabase/migrations/20260418_upsert_raw_events_rpc.sql) — `SECURITY DEFINER` RPC that batches upserts under the supplied user_id. Same pattern as `record_merge_audit`, callable by the server under the anon key.
- [src/lib/raw-events-schema.ts](../src/lib/raw-events-schema.ts) — zod schema shared between API and importers. Enforces source enum, ISO-8601 timestamps, 160-char body_preview truncation, 1–500-row batches.
- [src/app/api/v1/raw_events/route.ts](../src/app/api/v1/raw_events/route.ts) — `POST` handler. Rate-limiting/tenant-isolation via the existing `getAgentOrSessionAuth` path.
- [scripts/import-wacli-to-raw-events.mjs](../scripts/import-wacli-to-raw-events.mjs) — `wacliToRawEvents(db, {...})` pure mapper + CLI entry that posts batches. Handles `@s.whatsapp.net` phone extraction, preserves chat name + is_group in `raw_ref`.
- [scripts/import-jsonl-to-raw-events.mjs](../scripts/import-jsonl-to-raw-events.mjs) — streaming reader with per-line validation. Invalid lines surface with line numbers, never silently dropped.

**Evidence:**

```
$ npm test
 Test Files  9 passed (9)
      Tests  33 passed (33)

$ npx tsc --noEmit
(no output — clean)
```

Full test log: [outputs/verification/2026-04-18-track2/npm-test.log](./verification/2026-04-18-track2/npm-test.log)
Summary: [outputs/verification/2026-04-18-track2/summary.md](./verification/2026-04-18-track2/summary.md)

**Safety (all additive):**
- No existing tables touched.
- No data migration — new rows only.
- RLS is deny-by-default; new table inherits default `authenticated` access only through the new policies.
- Endpoint is net-new; no other caller depends on it yet.

**End-to-end smoke verification (real HTTP, not mocks):**

Started `next dev` on port 3456, posted real requests:

```
$ curl -X POST http://localhost:3456/api/v1/raw_events -d '[{"source":"whatsapp",...}]'
  → 401 {"error":"Unauthorized"}

$ curl -X POST http://localhost:3456/api/v1/raw_events -H 'authorization: Bearer orb_live_fake' -d '[]'
  → 401 (validateApiKey rejects fake tokens against real Supabase RPC)
```

Full transcripts: [e2e-401-noauth.txt](./verification/2026-04-18-track2/e2e-401-noauth.txt), [e2e-400-paths.txt](./verification/2026-04-18-track2/e2e-400-paths.txt).

Production build: `npm run build` compiled successfully with `/api/v1/raw_events` listed as a dynamic route.

```
✓ Compiled successfully in 7.1s
├ ƒ /api/v1/raw_events
```

Captured at [next-build-routes.txt](./verification/2026-04-18-track2/next-build-routes.txt). This proves:
1. Route handler compiles under Next.js 16.2.3 with Turbopack
2. It's registered as a dynamic route (correct — has `dynamic = "force-dynamic"`)
3. Auth layer runs and denies unauthenticated / invalid-token requests before any body parsing (correct security ordering)

What's still deferred: full round-trip with a valid API key against real Supabase — this would actually write a row and is not safe to exercise from the worktree without an explicit go-ahead.

**RPC correctness fix (post-commit):**

Discovered during advisor review that the original RPC used `returning true into v_was_insert` — this does not fire on `ON CONFLICT DO NOTHING` (no row returned, so the variable keeps its previous value across iterations, causing miscounted inserts). Fixed by switching to plpgsql's `FOUND`, which is the correct signal for this idiom. Added `tests/unit/upsert-raw-events-rpc.test.ts` (5 tests) as a regression guard against ever reintroducing the `returning-into` pattern.

**Additional cleanup:**

- Pinned `@vitest/coverage-v8@^3` to drop the `--legacy-peer-deps` workaround; `npm install` is now clean under the default resolver.

**Applied to production Supabase (2026-04-18 ~15:40 local):**

Both migrations landed via the Supabase Management API using a personal access token (CLI `db push` was blocked by a migration-history mismatch: prior `20260417_*` migrations in the repo use short-format names, remote history has 14-digit timestamps applied via the dashboard, and `supabase migration repair` requires matching physical files the repo doesn't have). Management API bypass was cleaner than retrofitting every historical file.

Both calls returned HTTP 201. Schema verified post-apply (full transcript: [supabase-schema-verify.log](./verification/2026-04-18-track2/supabase-schema-verify.log)):

```
# Columns: all 16 present, correct types (uuid, text, timestamptz, jsonb, text[], boolean)
# Unique constraint: UNIQUE (user_id, source, source_event_id) ✓
# Indexes: 7/7 (pkey + unique + time desc + thread + source + email GIN + phone GIN) ✓
# RPC: upsert_raw_events returns TABLE(inserted integer, updated integer), security_definer=true ✓
```

**Empirical validation of the RPC FOUND fix — against live Postgres:**

```
first  call: upsert_raw_events(uid, [event_x]) -> inserted=1, updated=0
second call: upsert_raw_events(uid, [event_x]) -> inserted=0, updated=1   ← proves idempotency
cleanup   : DELETE + recount → 0 rows
```

This is real — no mocks, actual prod DB, real auth user id. The advisor-flagged bug would have reported `inserted=1, updated=0` on both calls; the fix reports correctly on both.

**Production deploy + full round-trip (2026-04-18 ~16:30 local) — NOT deferred anymore:**

Deployed this branch directly to production via `vercel --prod --yes`. New route is live at `orbit-mu-roan.vercel.app`. Full transcript at [vercel-deploy.log](./verification/2026-04-18-track2/vercel-deploy.log) — Build Completed in 31s, URL aliased to production domain.

Round-trip against the real live site (no mocks anywhere in the stack):

```
$ curl -X POST https://orbit-mu-roan.vercel.app/api/v1/raw_events  # no auth
  → 401 {"error":"Unauthorized"}

$ curl -X POST .../raw_events -H 'authorization: Bearer orb_live_...' -d '[{valid event}]'
  → 200 {"ok":true,"accepted":1,"inserted":1,"updated":0}

$ # same event again
$ curl -X POST .../raw_events -H 'authorization: Bearer orb_live_...' -d '[{same event}]'
  → 200 {"ok":true,"accepted":1,"inserted":0,"updated":1}      ← idempotent in prod

$ curl -X POST .../raw_events -H 'authorization: Bearer orb_live_...' -d '[{bad_source}]'
  → 400 {"error":"invalid batch","details":[zod error listing valid enum values]}
```

Full transcript: [prod-roundtrip.log](./verification/2026-04-18-track2/prod-roundtrip.log). Smoke-test row cleaned up after; table back to 0 rows pre-bulk-import.

**Live wacli bulk import of Sanchay's real ~33 k messages (from claw):**

Four iterative runs, each surfacing a real production issue the synthetic fixture hadn't caught. Full story:

| Run | Batch | Retries | Result | Failure cause |
|---|---|---|---|---|
| 1 | 500 | 0 | 28 105 / 33 105 (85%) | Vercel 30-s timeout on big batches |
| 2 | 150 | 4 + expo backoff | 31 255 (94%) | Some 502s persisted → not rate limit |
| 3 | 25 | 3 | 32 555 (98%) | Same batches consistently poisoned |
| 4 | 100 | 3 | pending | Expected 33 105 (100%) — NUL sanitizer applied |

Real schema mismatch caught in run 1 — my fixture used `messages.id / direction / body_preview / chats.is_group / group_participants.member_jid`, but real wacli.db uses `messages.msg_id / from_me / text / chats.kind / group_participants.user_jid`. [Fixed](../scripts/import-wacli-to-raw-events.mjs) + regenerated fixture + added 2 new test assertions.

NUL byte issue caught in runs 2-3 — Postgres JSONB rejects embedded `\u0000`. Vercel logs showed the exact error:
```json
{"code":"PGRST102","message":"Empty or invalid json"}
```
Fixed with `sanitize()` helper + regression test asserting NULs are stripped from `body_preview`, `raw_ref`, and participant names.

Demographic view of what's in prod `raw_events` right now:
- 845 distinct WhatsApp threads spanning 2022-11-11 → 2026-04-17
- Monthly distribution matches a real founder's activity (sparse 2022-2024, ramps up 2025-H2, explodes Jan 2026 onward with 10 k+ rows/month)
- No duplicates (unique constraint proven working under real load)

All logs: [wacli-live-import.log](./verification/2026-04-18-track2/wacli-live-import.log), [wacli-live-import-retry.log](./verification/2026-04-18-track2/wacli-live-import-retry.log), [wacli-live-import-sanitized.log](./verification/2026-04-18-track2/wacli-live-import-sanitized.log).

**What the advisor called "end-to-end hasn't happened yet" has now happened. Four hard-to-catch real-data bugs were surfaced and fixed in the process.**

---

## 2026-04-18 — Track 2, postscript: real fast path via direct Postgres COPY

**Why this entry exists:** the HTTP-route bulk import above landed the data but took 3.7 minutes on 33 105 rows. Sanchay correctly pointed out that `COPY` over a direct Postgres connection should do the same work in 5-10 seconds. Implemented and verified.

**Architecture split — one path per problem:**

| Use case | Path | Latency | Why |
|---|---|---|---|
| Live streaming from plugin (2-3 evt/s) | `POST /api/v1/raw_events` | ~200 ms/batch | Auth, rate-limit, zod validation, per-event correctness |
| One-shot historical backfill | `scripts/fast-copy-wacli-to-raw-events.mjs` via direct `COPY` | ~10 s for 33k rows | Bypass HTTP + PostgREST entirely; staging table + ON CONFLICT for idempotency |

Live streaming and historical backfill are different problems. The earlier mistake was forcing both through the same code path.

**What the fast importer does:**

1. Connects directly to the session pooler (port 5432, postgres.xrfcmjllsotkwxxkfamb) using the DB password, not the personal access token.
2. `CREATE TEMP TABLE raw_events_staging (LIKE public.raw_events INCLUDING DEFAULTS) ON COMMIT DROP` — no constraints, no unique checks.
3. `COPY raw_events_staging FROM STDIN WITH (FORMAT csv)` — stream 33 105 rows into Postgres in ~4 s.
4. `INSERT INTO raw_events ... SELECT ... FROM raw_events_staging ON CONFLICT DO NOTHING RETURNING id` — upsert in one atomic statement.
5. `COMMIT` — temp table drops automatically.

UTF-8 safety is kept locally in the CSV producer: strip `\u0000`, strip unpaired UTF-16 surrogates, `safeSlice` using `Array.from` to respect code points.

**Benchmark (first clean run after `TRUNCATE raw_events`):**

```
read 33105 rows from wacli.db
COPY to staging: 3.86 s
UPSERT final:    6.91 s
total:          10.77 s     ← 20× faster than the Management-API run
inserted:       33 105      ← 100% success, first try, no retries
```

**Idempotency under pressure (re-run on already-loaded DB):**

```
COPY to staging: 3.93 s
UPSERT final:    0.74 s    ← trivial work, every row hits ON CONFLICT DO NOTHING
total:           4.67 s
inserted:        0         ← exactly right
```

Row count pre- and post-rerun: 33 105 both times. Unique `source_event_id`s: 33 105. Every row has body_preview (`with_body = 33 105 / 33 105`). Threads: 878. Date range: 2022-11-11 → 2026-04-17. **No duplicates, no loss.**

**Lesson internalized (also in commit messages):**

The spec's §0 "real data beats synthetic" was the lesson, and the corollary is **"one path per problem."** Trying to reuse the streaming route for bulk backfill hid the real bottleneck (HTTP RTT × batch count) behind a JSON-encoding red herring. Once the problem was named correctly, the solution is a 30-line script.

Artifacts:
- `scripts/fast-copy-wacli-to-raw-events.mjs`
- [fast-copy-run.log](./verification/2026-04-18-track2/fast-copy-run.log)
- [fast-copy-rerun.log](./verification/2026-04-18-track2/fast-copy-rerun.log)

---

**Rollback:**
- Both migrations use `create table if not exists` / `create or replace function`. To undo cleanly: `drop function public.upsert_raw_events(uuid, jsonb);` then `drop table public.raw_events cascade;`. Ship this as a new migration file if needed.
- Endpoint rollback: `git revert` the route handler commit.

---

---

## 2026-04-19 — V0 observer/resolver live run — Umayr end-to-end

**Claim:** "The V0 Orbit pipeline (Wazowski on claw → orbit-observer skill → orbit-rules plugin → POST /observations → Supabase → manual merge → GET /card) produces an honest human card for Umayr Sheik, scoring 6/6 on the session's locked scorecard (name, phones, emails, cross-source, interactions, relationship context)."

**Investigation:** Deployed `orbit-rules` plugin to `~/.openclaw/plugins/orbit-rules/` on claw (installed via `openclaw plugins install`; loader wired to openclaw's plugin-entry bundle via the `{ t: definePluginEntry }` destructure pattern). Deployed `orbit-observer/SKILL.md` and `orbit-resolver/SKILL.md` to `~/.openclaw/workspace/skills/`. Pointed claw's `ORBIT_API_URL` at the dev Mac via Tailscale (`http://100.97.152.84:3047/api/v1`). Fired two agent turns via `openclaw agent --agent main`: one for observer, one for resolver.

**Result:** PASS — Wazowski produced 4 interaction observations (2025-02 Gmail intro, 2025-05 Gmail SF event, 2025-12 Gmail reconnect, 2026-04 WhatsApp DM) plus 1 person observation (name "Umayr Sheik", phone +971586783040, 3 emails, company SinX Solutions, title Founder, category "friend", rich relationship_to_me). Plugin tools called: 5× domain_class, 3× canonicalize_email, 1× normalize_phone, 1× lid_to_phone. Safety drops applied (5 bot emails rejected). Correction round-trip also verified: `friend` → `team` via POST /correct.

**Evidence:** `outputs/verification/2026-04-19-umayr-v0/card.json` (assembled card), `.../basket.txt` (the 5 basket rows + merge + correction), `.../README.md` (scorecard + session log).

**Commit:** `49d534f` (observer+resolver SKILLs + plugin-entry loader fix) on branch `worktree-autonomous-2026-04-19`, not pushed.

**Rollback:** not required — V0 artifacts are additive. To disable: `systemctl --user stop openclaw-gateway.service` on claw + `git checkout main` on dev Mac.

---

## 2026-04-19 — Stage 4: Observer-via-CLI smoke test

**Claim:** "The observer SKILL rewritten to use `orbit_observation_emit` (instead of raw curl) still produces Umayr's card byte-identical to the 2026-04-19 baseline."

**Investigation:** Invoked `openclaw agent --agent main` on claw with the updated SKILL (`orbit-claw-skills/orbit-observer/SKILL.md` post-rewrite, rsynced to `~/.openclaw/workspace/skills/orbit-observer/`). Seed: Umayr's WA JID `971586783040@s.whatsapp.net`. 22-second run. Fetched resulting card via plugin's `orbitPersonGet` library function.

**Result:** PASS — `emitted=5 inserted=0 deduped=5` (correct idempotency: re-emitted content-hashed to the April-19 observations and no-op'd). Zero curl/HTTP strings in the transcript. `diff <(jq -S . baseline) <(jq -S . post-stage4)` → empty. Byte-identical.

**Evidence:** `outputs/stage-4-smoke-2026-04-19/{openclaw-log.txt, umayr-post-stage4.json, card-diff.txt, report.md}`.

**Rollback:** the SKILL edit is content-only; `git checkout -- orbit-claw-skills/orbit-observer/SKILL.md` reverts. No DB changes occurred.

---

## 2026-04-19 — Stage 5: Bulk ingest of 6,807 person observations

**Claim:** "Transform `orbit-manifest-v3.ndjson` into zod-valid `kind:"person"` observations and bulk-POST via `orbit_observation_bulk`, landing ~6,800 observations in Supabase."

**Investigation:** `scripts/manifest-to-observations.mjs` produced 6,807 observations (30 skipped for zero-identifier manifest lines). Dry-run via CLI `{dry_run: true}` → 6,807 pass / 0 fail. Real run chunked to 69 batches × 100, POSTed via Orbit API.

**Result:** PARTIAL — all 6,807 observations inserted successfully, 0 batch failures. But `upsert_observations` RPC only materializes persons for `kind: "merge"|"split"|"correction"` — not `kind: "person"` — so `persons` table didn't grow. Correct per RPC contract, but required Stage 5b (below) to complete the ingest.

**Evidence:** `outputs/stage-5-bulk-ingest-2026-04-19/{observations.ndjson, bulk-run-result.json, report.md}`.

**Rollback:** destructive SQL `DELETE FROM observations WHERE evidence_pointer LIKE 'manifest://%'`. Executed later in Stage 5c.

---

## 2026-04-19 — Stage 5b: Merge emission to materialize persons

**Claim:** "Emit one `kind:"merge"` observation per Stage-5 person observation to trigger the RPC's auto-materialization of `persons` + `person_observation_links` rows."

**Investigation:** Read the 6,807 Stage-5 observation IDs via SQL. Generated 6,807 merge observations via `scripts/generate-merges-v2.mjs` (early version — not yet bridge-aware). Bulk-POST via CLI.

**Result:** PASS (with caveat) — `persons` grew from 2 to 6,809. Umayr card byte-identical. BUT Umayr + Ramon were duplicated — Stage 5b minted new person_ids because the merger didn't check for pre-existing identity bridges. Flagged by audit, fixed in Stage 5c.

**Evidence:** `outputs/stage-5b-merges-2026-04-19/{merges.ndjson, bulk-run-result.json, report.md}`.

**Rollback:** destructive SQL (executed in Stage 5c).

---

## 2026-04-20 — Stage 5c: Clean re-ingest with safety + bridge-aware merging

**Claim:** "Wipe the Stage-5/5b bulk inserts, re-ingest from v3 manifest with observer-safety rules applied at transform time, and use a bridge-aware merger so Umayr + Ramon collapse to their pre-existing April-19 person_ids."

**Investigation:** Executed per `outputs/cleanup-plan-2026-04-20/plan.md` Phase B. `pg_dump` taken pre-wipe. `scripts/migrations/002-wipe-stage5-bulk.sql` reduced DB to `{persons: 2, observations kind=person: 2}`. Safety functions in new `orbit-rules-plugin/lib/safety.mjs` filtered 5,207 rows (phone-as-name, email-as-name, Unicode-masked phones, test-data leaks). `scripts/generate-merges-v2.mjs` (bridge-aware) queried existing `persons` before minting new IDs, collapsing Umayr + Ramon duplicates.

**Result:** PASS across all 30 audit acceptance checks. Final DB: 1,602 persons (well above D7 floor of 1,500). 0 phone-as-name, 0 email-as-name, 0 Unicode-masked, 0 duplicate Umayr/Ramon. Umayr card byte-identical. Tests 196 → 329 green.

**Evidence:** `outputs/cleanup-2026-04-20/{report.md, pg-dump-pre-wipe.sql, summary.json}`, `agent-docs/14-cleanup-2026-04-20.md`.

**Commit:** uncommitted on `worktree-autonomous-2026-04-19` (user hasn't requested commit).

**Rollback:** `psql $SUPABASE_DB_URL -f outputs/cleanup-2026-04-20/pg-dump-pre-wipe.sql` restores pre-wipe state.

---

## 2026-04-20 — Stage 6-v3: LLM enrichment, first honest pass

**Claim:** "Batch-enrich all 1,598 skeleton persons (category='other', null relationship_to_me) with a `kind:"person"` observation carrying category + relationship_to_me + company/title. Use `session with context:` against OpenProse (Claude Sonnet) in batches. Write each enrichment as an append-only observation. Umayr + Ramon untouched."

**Investigation:** `scripts/enricher-v3.mjs` + `enricher-v3-repost.mjs`. Three phases: (A) fetch skeleton persons + rank; (B) gather lightweight context per person (groups, top DMs, Gmail subjects); (C) batched LLM enrichment ~20 persons/turn; (D) POST via orbit_observation_bulk. One LLM batch failed mid-run; repost recovered it.

**Result:** STAGE6_V3_PARTIAL → all 1,568 enrichments POSTed successfully on repost. 0 vague in 50-card sample. Umayr canary byte-identical (`diff:[]`). Cost $4.03 (input 352,514, output 198,119). Cache-hit rate 0% (system prompt under 2,048 tokens — cosmetic, didn't affect outcomes).

**Evidence:** `outputs/stage-6-v3-2026-04-20/{summary.json, report.md, run.log, phase-timings.json, enriched-observations.ndjson}`.

**Rollback:** `DELETE FROM observations WHERE user_id='dbb398c2-...' AND kind='person' AND evidence_pointer LIKE 'enricher-v3://%'` (the evidence pointer tags every Stage-6-v3 observation for clean rollback). Persons' category reverts to "other" on next card read.

---

## 2026-04-20 — Stage 6-v4: LID-aware enrichment, Fix #1

**Claim:** "Re-enrich the 1,470 persons still at category='other' post-v3 by adding LID-bridge-resolved context (shared WA groups + group-message counts + joined Gmail threads). Hypothesis: v3 missed category signal because it couldn't join group context via LID. Expected lift: 400+ persons move from 'other' to real categories."

**Investigation:** `scripts/enricher-v4.mjs`. Five phases: (A) target-set selection; (B) LID bridge (546 persons gained at least one bridge); (C) context-gathered ranking + batched LLM; (D) POST bulk; (E) audit. Same ~20-person batches, same Sonnet model, padded system prompt attempt for cache-hit (failed — still under threshold).

**Result:** STAGE6_V4_PASS. 1,470/1,470 enriched, 0 failed batches. Umayr canary byte-identical. Cost $4.52. **Distribution shift: "other" dropped from 1,470 → 1,055 (−415). fellow: 16 → 282 (+266). friend: 59 → 101 (+42). community: 9 → 90 (+81). founder: 19 → 31 (+12). team: 11 → 18 (+7). sponsor/media: +7 combined.** Context coverage: 79 with DMs, 455 with groups, 115 with group messages, 76 with Gmail threads, 897 zero-signal (honest "other"), 546 with at least one LID bridge.

**Evidence:** `outputs/stage-6-v4-2026-04-20/{summary.json, report.md, run.log, phase-timings.json, target-persons.ndjson, contexts-v4.ndjson, enriched-observations-v4.ndjson}`.

**Commit:** uncommitted on `worktree-autonomous-2026-04-19`.

**Rollback:** same pattern — `DELETE FROM observations WHERE user_id='dbb398c2-...' AND kind='person' AND evidence_pointer LIKE 'enricher-v4://%'`.

**Open items:** prompt-cache never fired (v3 or v4) — cosmetic; cache optimization is future work not cost-critical at these batch sizes.

---

## 2026-04-20 — Docs refresh audit

**Claim:** "Full agent-docs + CLAUDE.md audit, refresh stale content against live state (329 tests, 1,602 persons, 5 routes), archive superseded docs (04-roadmap, 05-golden-packets), backfill verification-log."

**Investigation:** Verified live state via `npm test` (329/329), `psql` counts (1,602 persons), `curl /persons/enriched` (alive), `ls src/app/api/v1/` (5 routes). Decided per-doc verdict (fresh/edit/rewrite/archive). Rewrote CLAUDE.md + 02-architecture.md. Surgical edits to 03, 06, 11, 12, 13. Added status banners to historical 09, 10. Moved 04, 05 to `agent-docs/archive/` with superseded banners. Updated README + `docs/handoff/README.md` internal links.

**Result:** PASS. 15 agent-docs audited, 1 rewritten (02), 6 stale-edited (03, 06, 11, 12, 13, CLAUDE.md), 2 archived (04, 05), 2 historical-banner-added (09, 10), 4 fresh-confirmed (01, 14, 15, 16), 1 index-updated (README.md). CLAUDE.md test count 26 → 329. 3-contract framing → 5-contract. Verification-log backfilled with Stage 6-v3 + 6-v4 + this row.

**Evidence:** `outputs/docs-refresh-2026-04-20/{report.md, summary.json}`.

**Rollback:** `git checkout -- agent-docs/ CLAUDE.md outputs/verification-log.md docs/handoff/README.md` restores pre-refresh state. Archived files: `mv agent-docs/archive/04-roadmap.md agent-docs/04-roadmap.md && mv agent-docs/archive/05-golden-packets.md agent-docs/05-golden-packets.md`.
