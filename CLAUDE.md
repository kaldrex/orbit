# Orbit — agent context

Orbit is a **founder's relationship memory**. One structured record per human the founder has cross-channel activity with (WhatsApp, Gmail, Calendar, Slack, Linear). Paired with **OpenClaw**, an agent runtime on the founder's machine: OpenClaw is the hands, Orbit is the memory, the human is the trigger. Every action OpenClaw takes writes an observation back into Orbit — that feedback loop is the moat.

## The three contracts

The entire backend is three routes. Everything flows through one of them.

```
POST /api/v1/raw_events             → ledger ingress (agents write events)
GET  /api/v1/person/:id/packet      → canonical read (UI + agents)
POST /api/v1/person/:id/observation → learning write-back
```

One table (`raw_events`) is source of truth. Everything else — `interactions`, `persons`, Neo4j graph, packet cache — is a rebuildable projection.

## Tech stack

- **Framework:** Next.js 16 App Router + Turbopack (server-rendered dynamic routes + RSC)
- **DB:** Supabase Postgres (ledger + auth + observations) · Neo4j Aura (persons + edges)
- **Tests:** Vitest, `npm test`, 26 green
- **Plugin runtime:** OpenClaw (separate repo, runs on founder's machine)

<!-- BEGIN:nextjs-agent-rules -->
**This is NOT the Next.js you know.** Breaking changes to APIs, conventions, and file structure from older versions. Read the relevant guide in `node_modules/next/dist/docs/` before writing any route, middleware, or config code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## How to run

- Dev server: `npm run dev` (preview panel on port 3000)
- Tests: `npm test` — expect **26 passing**
- Build: `npx next build`
- Bulk import wacli → ledger: `node scripts/fast-copy-wacli-to-raw-events.mjs` (~10 s for 33 k rows)

## Deeper context — read what's relevant

See [agent-docs/README.md](./agent-docs/README.md) for the full index. Load a doc when its topic applies.

- [agent-docs/01-vision.md](./agent-docs/01-vision.md) — why we're building this, for whom, the moat
- [agent-docs/02-architecture.md](./agent-docs/02-architecture.md) — three contracts, classification rules, identity waterfall, LLM split
- [agent-docs/03-current-state.md](./agent-docs/03-current-state.md) — what exists on disk today, what's deleted, where data lives, what's in prod vs local
- [agent-docs/04-roadmap.md](./agent-docs/04-roadmap.md) — six tracks, status, dependencies, Track 3 sub-tasks
- [agent-docs/05-golden-packets.md](./agent-docs/05-golden-packets.md) — Track 3's diff target (the three canonical packet fixtures)
- [agent-docs/06-operating.md](./agent-docs/06-operating.md) — rules of engagement, standing authorities, verification-log format, commit template

## Non-negotiable rules

1. **No claim without evidence.** Every non-trivial build claim lands a row in [outputs/verification-log.md](./outputs/verification-log.md) with artifact + method + commit sha. See [agent-docs/06-operating.md](./agent-docs/06-operating.md).
2. **Real data beats synthetic.** Before writing a fixture, `.schema` or `MATCH` the actual source. Invented column names have cost us hours.
3. **UTF-8 sanitize on WhatsApp text.** NULs + unpaired UTF-16 surrogates break Postgres JSONB. Sanitizer pattern in [scripts/fast-copy-wacli-to-raw-events.mjs](./scripts/fast-copy-wacli-to-raw-events.mjs).
4. **Hard cutover.** Delete old code cleanly — no back-compat shims, no `_unused` aliases, no `// removed` comments, no feature flags for "easing the transition."
5. **Log-first, retry-never.** On two consecutive HTTP failures, open the server logs before touching retry count or batch size.

<important if="about to run destructive SQL, stop a service on claw, rotate credentials, force-push, or spend money beyond spec budgets">
Stop and read [agent-docs/06-operating.md](./agent-docs/06-operating.md) — that's the "requires explicit go" list. Ask before acting.
</important>

<important if="implementing any part of Track 3 (projection, packet assembler, /packet route, or /observation route)">
Load [agent-docs/05-golden-packets.md](./agent-docs/05-golden-packets.md) first. The three fixtures in [tests/fixtures/golden-packets/](./tests/fixtures/golden-packets/) are the diff contract. If your output drifts from them, the work is not done.
</important>
