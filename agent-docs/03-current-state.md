# 03 · Current state

> Ground-truth snapshot. What exists right now, where, and in what shape. Update this file when the answer changes.

_Last meaningful update: 2026-04-20 (post Stage 6-v4 enrichment + docs refresh). Docs [14-cleanup-2026-04-20.md](./14-cleanup-2026-04-20.md) and [15-future-props.md](./15-future-props.md) are the authoritative narrative; this doc is the ground-truth snapshot._

## Summary (2026-04-20, post Stage 6-v4)

- **Backend: 5 live API routes**, **329 tests green across 19 files**, **1,602 clean persons** in DB, `/persons/enriched` endpoint live.
- **Category distribution (latest observations):** other 1,055 · fellow 282 · friend 101 · community 90 · founder 31 · sponsor 20 · team 18 · media 5.
- **Rule layer: 10 modules** in `orbit-rules-plugin/lib/` — `safety`, `name`, `group-junk`, `bridge`, `forwarded`, `lid`, `phone`, `email`, `fuzzy`, `domain` + `data/domains.json`. All rules ship with tests.
- **CLI plugin: 4 verbs** (`orbit_observation_emit`, `orbit_observation_bulk`, `orbit_person_get`, `orbit_persons_list_enriched`) with 12-code error taxonomy + dry-run mode.
- **Observer + resolver SKILLs use CLI verbs**, not raw curl.
- **Stage 6-v3 + v4 enrichment:** $8.55 total spend, 547 persons meaningfully enriched, 1,055 honest "other" (placeholder). Fix-#1 LID bridge moved 415 persons out of "other" into real categories.
- **Clean data:** 0 phone-as-name, 0 email-as-name, 0 Unicode-masked violations, 0 duplicate person_ids for Umayr/Ramon. Umayr + Ramon cards byte-identical to April-19 baselines.
- **Multi-founder-ready:** `ORBIT_SELF_EMAIL` + `ORBIT_SELF_PHONE` env vars replaced Sanchay hardcode. See [13-multi-tenant-onboarding.md](./13-multi-tenant-onboarding.md).
- **Neo4j:** empty today but architecturally promoted back to first-class (see [15-future-props.md](./15-future-props.md) "Why Neo4j is load-bearing").

## Backend surface

Five live API routes + OAuth callback.

| Path | Purpose |
|---|---|
| [src/app/api/v1/raw_events/route.ts](../src/app/api/v1/raw_events/route.ts) | Ledger ingress — backfill + streaming |
| [src/app/api/v1/observations/route.ts](../src/app/api/v1/observations/route.ts) | POST (append) + GET (cursor-paginated read) |
| [src/app/api/v1/person/[id]/card/route.ts](../src/app/api/v1/person/[id]/card/route.ts) | GET — assembles card from linked observations |
| [src/app/api/v1/person/[id]/correct/route.ts](../src/app/api/v1/person/[id]/correct/route.ts) | POST — writes kind:"correction" with confidence=1.0 |
| [src/app/api/v1/persons/enriched/route.ts](../src/app/api/v1/persons/enriched/route.ts) | GET — paginated list of persons with non-placeholder category/relationship |
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
- [src/lib/graph-transforms.ts](../src/lib/graph-transforms.ts) — pure UI helpers (`CATEGORY_META`, `isJunkName`)
- [src/lib/reagraph-theme.ts](../src/lib/reagraph-theme.ts) — client theme
- [src/lib/utils.ts](../src/lib/utils.ts) — `cn()` helper

Scripts (load-bearing):

- [scripts/fast-copy-wacli-to-raw-events.mjs](../scripts/fast-copy-wacli-to-raw-events.mjs) — bulk `wacli.db` → `raw_events` via direct Postgres `COPY`
- [scripts/manifest-to-observations.mjs](../scripts/manifest-to-observations.mjs) — v3 manifest → observations (safety-filtered)
- [scripts/generate-merges-v2.mjs](../scripts/generate-merges-v2.mjs) — bridge-aware merger
- [scripts/reingest-stage5c.mjs](../scripts/reingest-stage5c.mjs) — bulk re-ingest driver
- [scripts/enricher-v3.mjs](../scripts/enricher-v3.mjs), [enricher-v4.mjs](../scripts/enricher-v4.mjs) — Stage-6 LLM enrichment
- [scripts/build-network-viz.mjs](../scripts/build-network-viz.mjs), [simulate-card.mjs](../scripts/simulate-card.mjs), [simulate-ramon.mjs](../scripts/simulate-ramon.mjs)

**Tests: 329 passing across 19 test files, full suite ~1.2s.**

Test layout:
- `tests/unit/` — 12 files: sanity, raw-events-schema, upsert-raw-events-rpc, observations-schema, card-assembler, orbit-rules-plugin (+ name / safety / group-junk variants), orbit-cli-plugin, generate-merges-v2, manifest-to-observations
- `tests/integration/` — 7 files: raw-events-endpoint, observations-endpoint, person-card-endpoint, person-correct-endpoint, persons-enriched-endpoint, wacli-to-raw-events, manifest-gen-enrichment-loop

Fixtures:

- [tests/fixtures/wacli-minimal.db](../tests/fixtures/wacli-minimal.db) (+ `.shm`/`.wal` + rebuild script)
- [tests/fixtures/golden-packets/](../tests/fixtures/golden-packets/) — retained but no longer load-bearing (see archived `04-roadmap.md`/`05-golden-packets.md`)

UI scaffolding still lives under `src/app/dashboard/`, `src/app/onboarding/`, `src/app/login/`, `src/app/signup/`, `src/components/*`. It renders, but several client components still `fetch` endpoints that no longer exist (`/api/graph`, `/api/init`, `/api/contacts`, `/api/keys`, `/api/v1/capabilities`) — those return 404. UI is deferred to Stage 8 post-enrichment.

## Data state

| Layer | State |
|---|---|
| Supabase `raw_events` | **33,105 rows**, all `source = 'whatsapp'`, from Sanchay's `wacli.db` bootstrap. Parked — V0 pipeline runs from observations, not from re-projecting `raw_events`. |
| Supabase `observations` | **~4,700 rows** (Sanchay's user_id): `person` 4,646 · `merge` 1,605 · `interaction` 7 · `correction` 1. Source of truth, append-only. |
| Supabase `persons` | **1,602 rows** (Sanchay's user_id). Post-Stage-5c + Stage-6-v4 enrichment. Category distribution: other 1,055 · fellow 282 · friend 101 · community 90 · founder 31 · sponsor 20 · team 18 · media 5. |
| Supabase `person_observation_links` | Scales with persons; materialized by `upsert_observations` RPC on merge/correction. |
| Supabase (other public tables) | `api_keys` (live — agent auth) · `profiles`. `merge_audit` and `connectors` **dropped** in migration 001. |
| Supabase `auth.users` | One user — `sanchaythalnerkar@gmail.com` (id `dbb398c2-1eff-4eee-ae10-bad13be5fda7`). Stored in `.env.local` as `ORBIT_USER_EMAIL` / `ORBIT_USER_PASSWORD`. |
| Supabase RPCs | `upsert_raw_events` · `upsert_observations` (auto-merges persons on kind:"merge") · `select_observations` · `select_person_observations` · `select_persons_page` (Phase-C enriched read). |
| Neo4j Aura | **Empty.** 0 nodes, 0 edges. **Architecturally first-class** post 2026-04-20 — see [15-future-props.md](./15-future-props.md) "Why Neo4j is load-bearing." Next load-bearing step post-enrichment. |
| Vercel prod (`orbit-mu-roan.vercel.app`) | **Still running pre-prune code.** Sixteen old routes still live there. Untouched until you push the clean `main`. |
| Claw VM (`openclaw-sanchay` on GCP) | Wazowski agent healthy (daily-briefing + memory-dreaming crons running clean). **`openclaw-gateway.service` failing** on every restart — `~/.openclaw/openclaw.json` still references a deleted `orbit-connector` plugin path, so port 18789 is dead. Two orbit crons (`orbit-full-ingest`, `orbit-relationship-sync`) **disabled 2026-04-19** — they were timing out every run. 41 pre-pivot files archived to `~/.openclaw/workspace/.archive/pre-pivot-2026-04-19/`. WhatsApp capture is currently dark: `gowa` logged out of WhatsApp 2026-04-09 06:29 UTC (local store truncated); `wacli.db` last written 2026-04-17 13:37 UTC — no one runs `wacli sync --follow` persistently. gws (Gmail / Calendar / Contacts) authorized + live. Full detail: [10-eda-findings-2026-04-19.md](./10-eda-findings-2026-04-19.md). |

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
