# 03 · Current state

> Ground-truth snapshot. What exists right now, where, and in what shape. Update this file when the answer changes.

_Last meaningful update: 2026-04-21 (post Phase 5 Living Orbit + LID bridge + A6 audit backfill). Docs [14-cleanup-2026-04-20.md](./14-cleanup-2026-04-20.md), [15-future-props.md](./15-future-props.md) and [18-neo4j-edge-model-proposal.md](./18-neo4j-edge-model-proposal.md) are the authoritative narrative; this doc is the ground-truth snapshot._

## Summary (2026-04-21, post Phase 5 Living Orbit)

- **Backend: 18 V1 API routes**, **508 tests green + 1 skipped across 35 files** (~8 s full suite), **1,602 clean persons** in DB.
- **Observations**: **29,771 rows** (Sanchay's `user_id`): merge 13,360 · interaction 11,762 · person 4,648 · correction 1. `person_observation_links` 29,768.
- **Neo4j Aura: populated and load-bearing.** 1,602 `:Person` nodes + **1,232 edges** (DM 135 · SHARED_GROUP 1,095 · EMAILED 2). Graph projection rebuilt via `/api/v1/graph/populate`; weight `ln(1+count) · exp(-days/180)`.
- **Category distribution (latest observations):** other 1,055 · fellow 282 · friend 101 · community 90 · founder 31 · sponsor 20 · team 18 · media 5.
- **Rule layer: 10 modules** in `orbit-rules-plugin/lib/` — `safety`, `name`, `group-junk`, `bridge`, `forwarded`, `lid`, `phone`, `email`, `fuzzy`, `domain` + `data/domains.json`. All rules ship with tests.
- **CLI plugin: v0.3.0, 16 verbs** (adds `orbit_lid_bridge_upsert` on top of v0.2.0's 15). 12-code error taxonomy + dry-run mode. Pure plumbing (no LLM, no ANTHROPIC_API_KEY).
- **Observer + resolver + meeting-brief + topic-resonance SKILLs use CLI verbs**, not raw curl. `orbit-job-runner/` shell dispatchers fan out to `openclaw agent`.
- **Stage 6-v3 + v4 enrichment:** $8.55 total spend, 547 persons meaningfully enriched, 1,055 honest "other" (placeholder). Fix-#1 LID bridge moved 415 persons out of "other" into real categories.
- **Topic resonance:** 699 person-topic rows, 99 persons with ≥1 topic (of 256 with message signal). $1.72 Haiku spend.
- **Living Orbit (Phase 5):** `jobs` queue + pg_cron (`*/15` observer, `0 *` meeting_sync, `0 3 1,15` enricher). claw systemd timer polls `/jobs/claim` every 15 min.
- **Clean data:** 0 phone-as-name, 0 email-as-name, 0 Unicode-masked violations, 0 duplicate person_ids for Umayr/Ramon. Umayr + Ramon cards byte-identical to April-19 baselines.
- **Multi-founder-ready:** `ORBIT_SELF_EMAIL` + `ORBIT_SELF_PHONE` env vars replaced Sanchay hardcode. See [13-multi-tenant-onboarding.md](./13-multi-tenant-onboarding.md).

## Backend surface

**18 V1 API routes** + OAuth callback, grouped by family.

Ledger + basket + card:

| Path | Purpose |
|---|---|
| [src/app/api/v1/raw_events/route.ts](../src/app/api/v1/raw_events/route.ts) | Ledger ingress — backfill + streaming |
| [src/app/api/v1/observations/route.ts](../src/app/api/v1/observations/route.ts) | POST (append) + GET (cursor-paginated read) |
| [src/app/api/v1/person/[id]/card/route.ts](../src/app/api/v1/person/[id]/card/route.ts) | GET — assembles card from linked observations |
| [src/app/api/v1/person/[id]/correct/route.ts](../src/app/api/v1/person/[id]/correct/route.ts) | POST — writes kind:"correction" with confidence=1.0 |

Card projections + people queries:

| Path | Purpose |
|---|---|
| [src/app/api/v1/persons/enriched/route.ts](../src/app/api/v1/persons/enriched/route.ts) | GET — paginated list (non-placeholder category/relationship) |
| [src/app/api/v1/persons/going-cold/route.ts](../src/app/api/v1/persons/going-cold/route.ts) | GET — cold-contact surface (score > 2 · 14d+ quiet) |
| [src/app/api/v1/self/init/route.ts](../src/app/api/v1/self/init/route.ts) | POST — mint `profiles.self_node_id` from `ORBIT_SELF_EMAIL` |
| [src/app/api/v1/person/[id]/topics/route.ts](../src/app/api/v1/person/[id]/topics/route.ts) | GET + POST — topic chip cloud |
| [src/app/api/v1/meetings/upcoming/route.ts](../src/app/api/v1/meetings/upcoming/route.ts) | GET + POST — next-72h meeting briefs |

Graph (Neo4j projection):

| Path | Purpose |
|---|---|
| [src/app/api/v1/graph/populate/route.ts](../src/app/api/v1/graph/populate/route.ts) | POST — rebuild Neo4j from Postgres card projections (idempotent MERGE) |
| [src/app/api/v1/graph/route.ts](../src/app/api/v1/graph/route.ts) | GET — nodes + links for dashboard |
| [src/app/api/v1/graph/neighbors/[id]/route.ts](../src/app/api/v1/graph/neighbors/[id]/route.ts) | GET — 1-hop neighborhood |
| [src/app/api/v1/graph/path/[from]/[to]/route.ts](../src/app/api/v1/graph/path/[from]/[to]/route.ts) | GET — pure-Cypher `shortestPath` (intro path) |
| [src/app/api/v1/lid_bridge/upsert/route.ts](../src/app/api/v1/lid_bridge/upsert/route.ts) | POST — upsert `lid_phone_bridge` projection (@lid → phone lookup) |

Infra · auth · scheduling:

| Path | Purpose |
|---|---|
| [src/app/api/v1/capabilities/route.ts](../src/app/api/v1/capabilities/route.ts) | GET — self-describing agent capability report |
| [src/app/api/v1/keys/route.ts](../src/app/api/v1/keys/route.ts) | POST — mint agent API key (session-auth) |
| [src/app/api/v1/jobs/claim/route.ts](../src/app/api/v1/jobs/claim/route.ts) | POST — pg_cron-fed job queue (FOR UPDATE SKIP LOCKED) |
| [src/app/api/v1/jobs/report/route.ts](../src/app/api/v1/jobs/report/route.ts) | POST — write result (succeeded/failed/retry) |
| [src/app/auth/callback/route.ts](../src/app/auth/callback/route.ts) | Supabase OAuth callback |

Lib files (keepers):

- [src/lib/raw-events-schema.ts](../src/lib/raw-events-schema.ts) — zod validation + `MAX_BATCH`
- [src/lib/observations-schema.ts](../src/lib/observations-schema.ts) — 5-kind zod discriminated union
- [src/lib/card-assembler.ts](../src/lib/card-assembler.ts) — pure fn, latest-wins + correction-override + Jaccard summary dedup
- [src/lib/api-auth.ts](../src/lib/api-auth.ts) — agent API-key + session-cookie auth primitives
- [src/lib/auth.ts](../src/lib/auth.ts) — Supabase session helpers
- [src/lib/supabase/client.ts](../src/lib/supabase/client.ts) + [server.ts](../src/lib/supabase/server.ts)
- [src/lib/categories.ts](../src/lib/categories.ts) — canonical UI category keys
- [src/lib/scoring.ts](../src/lib/scoring.ts) — pure relationship-intensity math
- [src/lib/graph-transforms.ts](../src/lib/graph-transforms.ts) — pure UI helpers (`CATEGORY_META`, `isJunkName`, dim-not-remove filter)
- [src/lib/graph-intelligence.ts](../src/lib/graph-intelligence.ts) — hub scoring, prefix match
- [src/lib/neo4j.ts](../src/lib/neo4j.ts) — driver singleton + retry/backoff (Phase 0)
- [src/lib/neo4j-writes.ts](../src/lib/neo4j-writes.ts) — `mergeNodes`, `mergeEdges`, prune, weight math
- [src/lib/topic-chip.ts](../src/lib/topic-chip.ts) — `topicChipStyle(weight, max)` helper
- [src/lib/reagraph-theme.ts](../src/lib/reagraph-theme.ts) — client theme
- [src/lib/utils.ts](../src/lib/utils.ts) — `cn()` helper

Scripts (load-bearing):

- [scripts/fast-copy-wacli-to-raw-events.mjs](../scripts/fast-copy-wacli-to-raw-events.mjs) — bulk `wacli.db` → `raw_events` via direct Postgres `COPY`
- [scripts/manifest-to-observations.mjs](../scripts/manifest-to-observations.mjs) — v3 manifest → observations (safety-filtered)
- [scripts/generate-merges-v2.mjs](../scripts/generate-merges-v2.mjs) — bridge-aware merger
- [scripts/reingest-stage5c.mjs](../scripts/reingest-stage5c.mjs) — bulk re-ingest driver
- [scripts/enricher-v3.mjs](../scripts/enricher-v3.mjs), [enricher-v4.mjs](../scripts/enricher-v4.mjs), [enricher-v5-haiku.mjs](../scripts/enricher-v5-haiku.mjs) — Stage-6 + Phase 5 LLM enrichment
- [scripts/populate-lid-bridge.mjs](../scripts/populate-lid-bridge.mjs) — SSH-based claw `session.db` → `lid_phone_bridge` projection
- [scripts/topic-resonance.mjs](../scripts/topic-resonance.mjs), [repost-topics.mjs](../scripts/repost-topics.mjs) — NER-to-topics pipeline + re-poster
- [scripts/build-network-viz.mjs](../scripts/build-network-viz.mjs), [simulate-card.mjs](../scripts/simulate-card.mjs), [simulate-ramon.mjs](../scripts/simulate-ramon.mjs)

**Tests: 529 passing + 2 skipped across 36 test files, full suite ~8 s.**

Test layout:
- `tests/unit/` — 18 files: sanity, raw-events-schema, upsert-raw-events-rpc, observations-schema, card-assembler, orbit-rules-plugin (+ name / safety / group-junk variants), orbit-cli-plugin, orbit-cli-new-verbs, resilient-worker, neo4j-client, graph-transforms, graph-intelligence, topic-chip, generate-merges-v2, manifest-to-observations
- `tests/integration/` — 17 files: raw-events-endpoint, observations-endpoint, person-card-endpoint, person-correct-endpoint, persons-enriched-endpoint, v1-persons-going-cold, v1-self-init, v1-meetings-upcoming, v1-person-topics, v1-keys, v1-capabilities, v1-jobs, graph-populate-route, graph-endpoints, graph-path-route, wacli-to-raw-events, manifest-gen-enrichment-loop

Skipped (1, intentional):
- `persons-enriched-endpoint.test.ts` — `describe.skipIf(!LIVE)` gated live-DB smoke test.

Fixtures:

- [tests/fixtures/wacli-minimal.db](../tests/fixtures/wacli-minimal.db) (+ `.shm`/`.wal` + rebuild script)
- [tests/fixtures/golden-packets/](../tests/fixtures/golden-packets/) — retained but no longer load-bearing (see archived `04-roadmap.md`/`05-golden-packets.md`)

UI lives under `src/app/dashboard/`, `src/app/onboarding/`, `src/app/login/`, `src/app/signup/`, `src/components/*`. The dashboard wires to V1 routes end-to-end (graph, persons/enriched, persons/going-cold, meetings/upcoming, person topics). Graph canvas uses force-directed default + dim-not-remove filter; `PersonPanel` shows days-since-last-touch + Going Cold badge + topic chip cloud.

## Data state

| Layer | State |
|---|---|
| Supabase `raw_events` | **33,105 rows**, all `source = 'whatsapp'`, from Sanchay's `wacli.db` bootstrap. Parked — the V1 pipeline runs from observations, not from re-projecting `raw_events`. |
| Supabase `observations` | **29,771 rows** (Sanchay's user_id): `merge` 13,360 · `interaction` 11,762 · `person` 4,648 · `correction` 1. Source of truth, append-only. |
| Supabase `persons` | **1,602 rows** (Sanchay's user_id). Post-Stage-5c + Stage-6-v4 enrichment. Category distribution: other 1,055 · fellow 282 · friend 101 · community 90 · founder 31 · sponsor 20 · team 18 · media 5. |
| Supabase `person_observation_links` | **29,768 rows.** Materialized by `upsert_observations` RPC on merge/correction. |
| Supabase `api_keys` | 3 rows — agent auth. |
| Supabase `capability_reports` | 0 rows — table exists for the `/capabilities` agent-report surface. |
| Supabase `meetings` | 5 rows (next-72h meeting briefs). |
| Supabase `person_topics` | 699 rows covering 99 persons with ≥1 topic. |
| Supabase `lid_phone_bridge` | **14,995 rows** — WhatsApp `@lid` → `phone` projection cache from claw's `whatsmeow_lid_map`. Lookup only (not an identity claim). |
| Supabase `jobs` | 4 rows (test fixtures from Phase 5 HTTP verification). Rows drain naturally as workers complete. |
| Supabase `auth.users` | One user — `sanchaythalnerkar@gmail.com` (id `dbb398c2-1eff-4eee-ae10-bad13be5fda7`). Stored in `.env.local` as `ORBIT_USER_EMAIL` / `ORBIT_USER_PASSWORD`. |
| Supabase RPCs | `upsert_raw_events` · `upsert_observations` (auto-merges persons on kind:"merge") · `select_observations` · `select_person_observations` · `select_persons_page` · `select_person_card_rows` · `select_graph_nodes` · `select_phone_person_map` · `select_dm_thread_stats` · `select_group_thread_phones` · `select_email_interactions` · `select_group_thread_lids` · `upsert_lid_bridge` · `select_lid_phone_map` · `set_profile_self_node_id` · `upsert_meeting` · `select_upcoming_meetings` · `upsert_person_topics` · `select_person_topics` · `mint_api_key` · `enqueue_job` · `claim_next_job` · `report_job_result` · `cron_enqueue_observer_ticks` · `cron_enqueue_enricher_ticks` · `cron_enqueue_meeting_sync_ticks`. |
| Supabase `pg_cron` | `orbit-observer-tick` (`*/15 * * * *`) · `orbit-meeting-sync-tick` (`0 * * * *`) · `orbit-enricher-tick` (`0 3 1,15 * *`). |
| Neo4j Aura | **1,602 `:Person` nodes + 1,232 edges** — DM 135 · SHARED_GROUP 1,095 · EMAILED 2. Populated via `/api/v1/graph/populate` from Postgres card projections; LID bridge resolves 98.2% of group-thread LIDs. See [18-neo4j-edge-model-proposal.md](./18-neo4j-edge-model-proposal.md) for the edge schema. |
| Vercel prod (`orbit-mu-roan.vercel.app`) | **Torn down** — intentional clean slate per `project_orbit_deployment_burned.md`. Claw talks to Mac dev server via Tailscale (`100.97.152.84:3047`) until redeploy. |
| Claw VM (`openclaw-sanchay` on GCP) | Wazowski agent healthy. `orbit-job-runner.timer` active — 15-min tick drains `/api/v1/jobs/claim` via `openclaw agent --agent main --json`. Full earlier-state history: [10-eda-findings-2026-04-19.md](./10-eda-findings-2026-04-19.md). |

## What's gone (clean-slate prune, 2026-04-18)

96 files, **−11,417 net LOC** removed across three commits: `2aa1638`, `c41257d`, `6dc5769`.

- **13 old API routes** — `/api/v1/{ingest, merge, reset, persons, search, briefs, edges, graph, capabilities}` + `/api/{graph, contacts, person, search, init, keys, connectors/whatsapp}`
- **5 lib files** — `neo4j.ts` (324), `self-identity.ts` (86), `ingest-filters.ts` (138), `cypher/resolve-participants.js` (79), `cypher/co-present-edge.cypher` (21)
- **10 scripts** — old resolver drivers, verification scorecard, bleed replay, group-participant import, LID bridge, duplicate bulk-copy, JSONL importer, mock agentic-context, data export, cleanup migration
- **5 test files** — `interacted-edge-fields`, `gmail-availability`, `group-participants-import`, `lid-bridge`, `jsonl-to-raw-events`
- **Both OpenClaw plugin packages** — `packages/orbit-plugin/` (5,039 LOC, five connectors + signal-buffer + identity-resolver) and `packages/openclaw-plugin/` (drop-in wrapper)
- **8 stale handoff docs** (`01`–`08`) moved to `docs/archive/`
- **40 MB of untracked outputs** in the parent repo (`hypothesis-test-*`, `orbit-source-output-*`, `whole-data/`, `agentic-mock-*`)

## Credentials + env

All in `.env.local` (worktree and parent repo — both in sync):

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — browser-safe
- `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_URL`, `SUPABASE_DB_PASSWORD` — server/CLI only
- `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`, `NEO4J_DATABASE`
- `ORBIT_API_KEY`, `ORBIT_API_URL`
- `ORBIT_SELF_EMAIL` (comma-separated supported), `ORBIT_SELF_PHONE` — the founder/self identity anchor
- `ORBIT_USER_EMAIL`, `ORBIT_USER_PASSWORD` — dev login
- `WACLI_DB` (optional; defaults to `~/.wacli/wacli.db`)

## Git state

- Default branch: `main` at [github.com/kaldrex/orbit](https://github.com/kaldrex/orbit). Fast-forwarded to `6dee92c` on 2026-04-19 (3 docs-only commits from the data-gathering session).
- Active claude worktree: `.claude/worktrees/silly-cori-95f535` on branch `claude/silly-cori-95f535`. Merged to main 2026-04-19 — can be removed if no further work queued on it.
- No other claude worktrees. Two codex worktrees under `~/.codex/worktrees/` are separate and left alone.

## Changelog

| Date | Change |
|---|---|
| 2026-04-18 | Clean-slate prune. Deleted 13 API routes, 5 lib files, 10 scripts, 5 tests, both plugin packages, stale docs. Neo4j wiped. Claw plugins removed. `main` is now the single source of truth for the clean backend. Agent-docs layer introduced. |
| 2026-04-19 | Data-gathering / EDA session. No code changes. VM cleanup: disabled `orbit-full-ingest` + `orbit-relationship-sync` crons (both were failing every run), archived 41 pre-pivot files (30 `orbit_*.py` scripts + 11 `memory/2026-04-*-orbit-ingest*.md` logs) to `~/.openclaw/workspace/.archive/pre-pivot-2026-04-19/`. Added [10-eda-findings-2026-04-19.md](./10-eda-findings-2026-04-19.md) — the authoritative handoff. Design decisions locked to Claude auto-memory: V0 channel scope (WhatsApp first, Apple deferred), single-source is first-class, observations carry reasoning chains, resolver-as-OpenClaw-skill. |
| 2026-04-19 (late) | V0 pipeline built end-to-end: observations schema + card assembler + POST/GET routes + correction flow. Orbit-rules plugin with 5 tools deployed to claw. Observer + resolver SKILLs deployed. 108 tests green. 2 cards verified (Umayr, Ramon). See [11-v0-pipeline-handoff-2026-04-19.md](./11-v0-pipeline-handoff-2026-04-19.md). |
| 2026-04-20 | Cleanup session per audit findings. 4 phases landed: (A) WhatsApp depth — 5 new rule modules with ~30 tests; (B) DB wipe + safety re-ingest — 6,807 dirty rows → 1,602 clean; (C) Enrichment loop — `/api/v1/persons/enriched` route + CLI verb + manifest-gen merge-back; (D) Docs/memory sync (this update + doc 14 + memory entries). `ORBIT_SELF_EMAIL` hardcode removed. Tests 108 → 329. Memory updated with `project_openclaw_is_a_public_framework`, `project_api_is_only_writer`, expanded `feedback_explain_with_concrete_examples`. See [14-cleanup-2026-04-20.md](./14-cleanup-2026-04-20.md). |
| 2026-04-20 (late) | Stage 6-v3 + v4 LLM enrichment. v3: 1,568 persons enriched via batched `session with context:` against OpenProse, $4.03, 0/50 vague sample. v4 (Fix #1 — LID bridge): re-targeted 1,470 "other" persons with group/thread-joined context, $4.52, 415 moved from "other" to real categories (fellow/friend/community/founder/team). Total spend: $8.55. New doc [15-future-props.md](./15-future-props.md) captures strategic inventory + Neo4j first-class reinstatement. |
| 2026-04-20 (docs refresh) | Full doc audit. `04-roadmap.md` + `05-golden-packets.md` archived (pre-V0 framings). CLAUDE.md rewritten (3-contracts → 5 routes, 26 tests → 329, adds CLI/API rules). 03, 06, 11, 12, 13 surgical edits. verification-log.md backfilled with Stage 6-v3 + 6-v4 rows. See `outputs/docs-refresh-2026-04-20/report.md`. |
| 2026-04-21 | V1 full delivery — Phase 0 (api_keys + neo4j client + capabilities + keys routes), Phase 1 (dashboard wire + interaction pipeline + card-row RPC), Phase 2 (graph populate + constellation render), Phase 3 (intro path + communities + centrality), Phase 4 (going-cold + meeting briefs + topic resonance), Phase 4.5 (orbit-cli v0.2.0 rebalance), 5 UI fixes, LID bridge (edges 160 → 1,232), Phase 5 Living Orbit (jobs queue + pg_cron + Haiku enricher + claw runner). Tests 329 → 508 across 35 files. Neo4j populated to 1,602 nodes + 1,232 edges. |
| 2026-04-21 (audit backfill) | A6 audit: verification-log backfilled with 8 missing rows (5 UI dashboard fixes, orbit-cli v0.2.0 rebalance, Going Cold standalone, Meeting Briefs standalone, claw job-runner follow-up). CLAUDE.md + 03-current-state.md + README.md stale counts refreshed (329 → 508 tests, 19 → 35 files, 5 → 18 routes, 4 → 16 CLI verbs). Doc 18 indexed. |
