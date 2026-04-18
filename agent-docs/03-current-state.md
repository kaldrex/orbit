# 03 · Current state

> Ground-truth snapshot. What exists right now, where, and in what shape. Update this file when the answer changes.

_Last meaningful update: 2026-04-18, after the clean-slate prune (commit `bfb861e`)._

## Backend surface

Two routes. That's it.

| Path | Purpose | LOC |
|---|---|---|
| [src/app/api/v1/raw_events/route.ts](../src/app/api/v1/raw_events/route.ts) | Ledger ingress — all agents + backfill post here | 65 |
| [src/app/auth/callback/route.ts](../src/app/auth/callback/route.ts) | Supabase OAuth callback | — |

Ten lib files, all keepers:

- [src/lib/raw-events-schema.ts](../src/lib/raw-events-schema.ts) — zod validation + `MAX_BATCH`
- [src/lib/api-auth.ts](../src/lib/api-auth.ts) — agent API-key + session-cookie auth primitives
- [src/lib/auth.ts](../src/lib/auth.ts) — Supabase session helpers
- [src/lib/supabase/client.ts](../src/lib/supabase/client.ts) + [server.ts](../src/lib/supabase/server.ts)
- [src/lib/categories.ts](../src/lib/categories.ts) — canonical UI category keys
- [src/lib/scoring.ts](../src/lib/scoring.ts) — pure relationship-intensity math
- [src/lib/graph-transforms.ts](../src/lib/graph-transforms.ts) — pure UI helpers (`CATEGORY_META`, `isJunkName`)
- [src/lib/reagraph-theme.ts](../src/lib/reagraph-theme.ts) — client theme
- [src/lib/utils.ts](../src/lib/utils.ts) — `cn()` helper

One script:

- [scripts/fast-copy-wacli-to-raw-events.mjs](../scripts/fast-copy-wacli-to-raw-events.mjs) — bulk `wacli.db` → `raw_events` via direct Postgres `COPY`. Exports `wacliToRawEvents(db, { connectorVersion?, skipIds? })` as a pure mapper. 33k rows in ~10s.

Five test files, 26 tests, all green, full suite ~1s:

- [tests/unit/sanity.test.js](../tests/unit/sanity.test.js)
- [tests/unit/raw-events-schema.test.ts](../tests/unit/raw-events-schema.test.ts) — 8 tests
- [tests/unit/upsert-raw-events-rpc.test.ts](../tests/unit/upsert-raw-events-rpc.test.ts) — 5 tests
- [tests/integration/raw-events-endpoint.test.ts](../tests/integration/raw-events-endpoint.test.ts) — 5 tests
- [tests/integration/wacli-to-raw-events.test.js](../tests/integration/wacli-to-raw-events.test.js) — 7 tests

Fixtures:

- [tests/fixtures/wacli-minimal.db](../tests/fixtures/wacli-minimal.db) (+ `.shm`/`.wal` + rebuild script)
- [tests/fixtures/golden-packets/](../tests/fixtures/golden-packets/) — Track 3 acceptance targets

UI scaffolding still lives under `src/app/dashboard/`, `src/app/onboarding/`, `src/app/login/`, `src/app/signup/`, `src/components/*`. It renders, but several client components still `fetch` endpoints that no longer exist (`/api/graph`, `/api/init`, `/api/contacts`, `/api/keys`, `/api/person/:id`, `/api/v1/capabilities`) — those return 404. UI is intentionally out of scope until Track 3's `/packet` lands.

## Data state

| Layer | State |
|---|---|
| Supabase `raw_events` | **33,105 rows**, all `source = 'whatsapp'`, from Sanchay's `wacli.db`. Unique on `(user_id, source, source_event_id)`. Re-import produces 0 new rows. |
| Supabase (other public tables) | `api_keys` (2 rows, live — agent auth) · `profiles` (1 row, `self_node_id` nulled post Neo4j-wipe). `merge_audit` (603 rows, dead) and `connectors` (0 rows, dead) were **dropped** in migration `scripts/migrations/001-supabase-clean-slate.sql`. See [02-architecture.md](./02-architecture.md) §Supabase Postgres for the full table list. |
| Supabase `auth.users` | One user — `sanchaythalnerkar@gmail.com` (id `dbb398c2-1eff-4eee-ae10-bad13be5fda7`). Password reset this session; stored in `.env.local` as `ORBIT_USER_EMAIL` / `ORBIT_USER_PASSWORD`. |
| Neo4j Aura | **Empty.** 0 nodes, 0 edges. The 1,711-person / 366k-edge pre-pivot graph was wiped — it was never touched by Track 1 or 2, all fossil from an older `/api/v1/ingest` path. Schema (2 built-in LOOKUP indexes) preserved. |
| Vercel prod (`orbit-mu-roan.vercel.app`) | **Still running pre-prune code.** Sixteen old routes still live there. Untouched until you push the clean `main`. |
| Claw VM (`openclaw-sanchay` on GCP) | `openclaw-gateway.service` **stopped**. Plugins `orbit-connector/` and `orbit-saas/` deleted. Nothing is currently posting events anywhere. |

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

- Default branch: `main` at [github.com/kaldrex/orbit](https://github.com/kaldrex/orbit). Fast-forwarded this session.
- Active claude worktree: `.claude/worktrees/eloquent-stonebraker-d61d79` on branch `claude/eloquent-stonebraker-d61d79`.
- No other claude worktrees. Two codex worktrees under `~/.codex/worktrees/` are separate and left alone.
- Stale origin branches (`docs/spec-suite`, `feat/plugin-provenance-passthrough`) deleted this session.

## Changelog

| Date | Change |
|---|---|
| 2026-04-18 | Clean-slate prune. Deleted 13 API routes, 5 lib files, 10 scripts, 5 tests, both plugin packages, stale docs. Neo4j wiped. Claw plugins removed. `main` is now the single source of truth for the clean backend. Agent-docs layer introduced. |
