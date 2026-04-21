# Orbit — agent context

Orbit is a **founder's relationship memory**. One structured card per human the founder has cross-channel activity with (WhatsApp, Gmail, Calendar, Contacts — later Slack, Linear). Paired with **OpenClaw**, a public agent framework the founder runs on their own machine. OpenClaw is the hands, Orbit is the memory, the human is the trigger. Every action OpenClaw's skills take writes an observation back into Orbit — that feedback loop is the moat.

## The API surface (18 V1 routes across ~13 families)

Every write is via HTTP. Orbit never reads a raw source; it's fed by agent skills running on the founder's claw.

Ledger + basket + card (load-bearing core):
```
POST /api/v1/raw_events                → ledger ingress (agents + bulk backfill post here)
POST /api/v1/observations              → append-only basket (5 kinds: interaction/person/correction/merge/split)
GET  /api/v1/observations              → cursor-paginated read
GET  /api/v1/person/:id/card           → canonical card (UI + agents)
POST /api/v1/person/:id/correct        → human correction as kind:"correction" obs
```

Surfaces that query card projections:
```
GET  /api/v1/persons/enriched          → paginated list (non-placeholder category/relationship)
GET  /api/v1/persons/going-cold        → cold-contact surface (score > 2 · 14d+ quiet)
POST /api/v1/self/init                 → mint profiles.self_node_id from ORBIT_SELF_EMAIL (idempotent)
GET/POST /api/v1/person/:id/topics     → topic chip cloud
GET/POST /api/v1/meetings/upcoming     → next-72h meeting briefs
```

Graph (Neo4j projection):
```
POST /api/v1/graph/populate            → rebuild Neo4j nodes + edges from observations
GET  /api/v1/graph                     → nodes + links for dashboard
GET  /api/v1/graph/neighbors/:id       → 1-hop neighborhood around a person
GET  /api/v1/graph/path/:from/:to      → pure-Cypher shortestPath (returns intro path)
POST /api/v1/lid_bridge/upsert         → projection cache for WhatsApp @lid → phone
```

Infra / auth / scheduling:
```
GET  /api/v1/capabilities              → self-describing agent capability report
POST /api/v1/keys                      → mint agent API key (session-auth)
POST /api/v1/jobs/claim                → pg_cron-fed job queue (FOR UPDATE SKIP LOCKED)
POST /api/v1/jobs/report                → write result (succeeded/failed/retry)
```

`observations` is the source of truth. `persons` + `person_observation_links` are server-materialized projections (via the `upsert_observations` RPC's auto-merge). Cards are assembled per-read from observations. Neo4j is a one-way projection of card data (no write-back); `lid_phone_bridge` is a lookup cache, not an identity claim. See `agent-docs/18-neo4j-edge-model-proposal.md` for the edge schema.

## Tech stack

- **Framework:** Next.js 16 App Router + Turbopack
- **DB:** Supabase Postgres (ledger + auth + observations + persons via RLS). Neo4j Aura empty (deferred but first-class).
- **Tests:** Vitest, `npm test`, **508 passing + 1 skipped across 35 test files** (~8 s full suite).
- **Agent runtime:** OpenClaw (public MIT framework by Peter Steinberger, ~360k stars, Nov 2025) running on the founder's machine. Not Orbit's product.

<!-- BEGIN:nextjs-agent-rules -->
**This is NOT the Next.js you know.** Breaking changes to APIs, conventions, and file structure from older versions. Read the relevant guide in `node_modules/next/dist/docs/` before writing any route, middleware, or config code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## How to run

- Dev server: `./dev` (worktree-pinned PORT 3047; or `npm run dev` on 3000)
- Tests: `npm test` — expect **505 passing + 1 skipped** (33 test files, ~7 s)
- Build: `npx next build`
- Bulk import wacli → ledger: runs on claw via the `orbit-observer-backfill` SKILL (verbs `orbit_raw_events_backfill_from_wacli` + `orbit_lid_bridge_ingest` + `orbit_interactions_backfill`). No SSH, no Node script on the founder's Mac.

## Plugins (shipped on claw)

- `orbit-rules-plugin/` — 10 modules: `safety`, `name`, `group-junk`, `bridge`, `forwarded`, `lid`, `phone`, `email`, `fuzzy`, `domain` + `data/domains.json`. Rules called as OpenClaw tools by the observer/resolver skills.
- `orbit-cli-plugin/` — **v0.4.0, 19 verbs**: the original 16 plus `orbit_raw_events_backfill_from_wacli`, `orbit_lid_bridge_ingest`, `orbit_interactions_backfill` (onboarding backfill verbs). Pure plumbing (no LLM, no ANTHROPIC_API_KEY).
- SKILLs on claw: `orbit-observer`, `orbit-resolver`, `orbit-observer-backfill`, `orbit-enricher`, `orbit-meeting-brief`, `orbit-topic-resonance` (under `orbit-claw-skills/`).

## Deeper context — read what's relevant

See [agent-docs/README.md](./agent-docs/README.md) for the full index. Start with 14 + 15 if fresh.

- [agent-docs/14-cleanup-2026-04-20.md](./agent-docs/14-cleanup-2026-04-20.md) — current state, audit narrative, 1,602 clean persons
- [agent-docs/15-future-props.md](./agent-docs/15-future-props.md) — strategic inventory, Neo4j case, Stage 7 loop
- [agent-docs/11-v0-pipeline-handoff-2026-04-19.md](./agent-docs/11-v0-pipeline-handoff-2026-04-19.md) — V0 architecture narrative (observer → basket → resolver → card)
- [agent-docs/13-multi-tenant-onboarding.md](./agent-docs/13-multi-tenant-onboarding.md) — onboarding Hardeep/chad
- [agent-docs/12-junk-filtering-system.md](./agent-docs/12-junk-filtering-system.md) — 3-layer blocklist design
- [agent-docs/01-vision.md](./agent-docs/01-vision.md) · [02-architecture.md](./agent-docs/02-architecture.md) — product framing
- [agent-docs/03-current-state.md](./agent-docs/03-current-state.md) — ground-truth snapshot
- [agent-docs/06-operating.md](./agent-docs/06-operating.md) — rules of engagement, verification-log format

Archived: `agent-docs/archive/04-roadmap.md`, `agent-docs/archive/05-golden-packets.md` (pre-V0 framings).

## Non-negotiable rules

1. **No claim without evidence.** Every non-trivial build claim lands a row in [outputs/verification-log.md](./outputs/verification-log.md) with artifact + method + commit sha. See [agent-docs/06-operating.md](./agent-docs/06-operating.md).
2. **Real data beats synthetic.** Before writing a fixture, `.schema` or `MATCH` the actual source. Invented column names have cost us hours.
3. **UTF-8 sanitize on WhatsApp text.** NULs + unpaired UTF-16 surrogates break Postgres JSONB. Sanitizer pattern in [orbit-cli-plugin/lib/client.mjs](./orbit-cli-plugin/lib/client.mjs) (`cleanString` / `wacliRowsToRawEvents`).
4. **Hard cutover.** Delete old code cleanly — no back-compat shims, no `_unused` aliases, no `// removed` comments, no feature flags for "easing the transition."
5. **Log-first, retry-never.** On two consecutive HTTP failures, open the server logs before touching retry count or batch size.
6. **API is the only writer.** Nothing bypasses HTTP to touch `observations`/`persons` directly. SSH-to-DB is dev scaffolding, not a product path. Memory entry: `project_api_is_only_writer.md`.
7. **CLI is plumbing.** The `orbit` CLI owns arg parsing, HTTP transport, batching, auth, output formatting — nothing else. All LLM judgment stays in observer/resolver SKILLs funded by the founder's own token budget. Memory entry: `project_orbit_needs_its_own_cli_plugin.md`.

<important if="about to run destructive SQL on production data, stop a service on claw, rotate credentials, force-push, or spend money beyond spec budgets">
Stop and read [agent-docs/06-operating.md](./agent-docs/06-operating.md) — that's the "requires explicit go" list. Ask before acting. Supabase is a test/clone environment (`project_supabase_is_test_env.md`); destructive ops there are fine without pause.
</important>
