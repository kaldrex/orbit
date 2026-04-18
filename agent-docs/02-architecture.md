# 02 · Architecture

> The "how." Read this before touching schema, routes, projection, or identity resolution.

## Three durable layers (the inversion)

1. **`raw_events`** — immutable append-only ledger in Supabase Postgres. One row per source event. Idempotent on `(user_id, source, source_event_id)`. Schema lives in [src/lib/raw-events-schema.ts](../src/lib/raw-events-schema.ts); table DDL applied directly via Management API. Columns defined in [design spec §2](../docs/superpowers/specs/2026-04-18-orbit-v0-design.md).
2. **`interactions`** — deterministic projection from `raw_events`. One row per cross-source interaction with identity resolved. **Not built yet** (Track 3.1).
3. **`persons` + Neo4j graph + packet cache** — canonical entities, aliases, segment, relationship stats, LLM-enriched context. **Not built yet** (Track 3.2–3.4). Neo4j is currently empty — we wiped the pre-pivot graph.

**Rule:** if you're tempted to write anything *other* than `raw_events` from a source connector, stop. Sources write to the ledger. Everything else is downstream of the ledger.

## Three API contracts (the loop)

The entire backend surface is three routes. Everything agents or UI does goes through one of them.

### 1. Write events → `POST /api/v1/raw_events`

- Ingress for every channel. OpenClaw plugin, backfill scripts, future sources all post here.
- Idempotent batch upsert via the `upsert_raw_events` Postgres RPC.
- Auth: agent API key (`ORBIT_API_KEY`) or Supabase session.
- Implementation: [src/app/api/v1/raw_events/route.ts](../src/app/api/v1/raw_events/route.ts) (65 LOC).
- Max batch: see `MAX_BATCH` in [src/lib/raw-events-schema.ts](../src/lib/raw-events-schema.ts).

### 2. Read packet → `GET /api/v1/person/:id/packet`

- **Not built yet** (Track 3.4). Track 3's packet assembler must produce JSON diff-clean against [tests/fixtures/golden-packets/](../tests/fixtures/golden-packets/).
- Read path for both UI and OpenClaw agents.
- Returns person identity + interactions + observations + enrichment in one JSON blob.

### 3. Write observation → `POST /api/v1/person/:id/observation`

- **Not built yet** (Track 3.5). Agent learning surface — tone corrections, segment hints, merge candidates, snoozes, corrections.
- Observation shape (kind/value/confidence/source/evidence) defined in [design spec §6](../docs/superpowers/specs/2026-04-18-orbit-v0-design.md).
- Observations are immutable, time-ordered, merged into packets on schedule. Bad ones can be suppressed; good ones compound.

**That's the whole protocol. Three routes. One table. One graph. One packet.**

## Classification rules

Sixteen first-match-wins rules that turn a resolved person into a UI category (`self · team · investor · sponsor · fellow · media · community · gov · founder · friend · press · other`). Rule 16 is an LLM fallback for the ~1–5% that nothing else catches.

- Full table (rule · test · category): [design spec §3](../docs/superpowers/specs/2026-04-18-orbit-v0-design.md)
- Canonical category keys: `CATEGORY_META` in [src/lib/graph-transforms.ts](../src/lib/graph-transforms.ts)

Do not duplicate the rule list here. If you need to tweak a rule, edit the spec + the table implementation together.

## Identity resolution

**Name waterfall** (priority order — fall through until one produces a displayable name):

1. Google Contacts `displayName` matched by canonical E.164 phone
2. wacli `full_name`
3. wacli `push_name`
4. wacli `first_name`
5. `business_name`
6. → **Side bucket** ("Needs review" — stays out of main graph, keeps history, graduates out when a name arrives)

**Merge rules** (applied after waterfall picks a name):

- Deterministic: same phone · same email · same JID → auto-merge
- Pattern: Google Contacts name-token bridge from WA phone to Gmail sender
- Fuzzy: Levenshtein ≤2 on ≥2 normalized tokens → human-review queue
- **Never** auto-merge on single-token collisions (e.g. `Jain` / `Yadav`)

Full detail: [design spec §5](../docs/superpowers/specs/2026-04-18-orbit-v0-design.md).

## LLM responsibility split

Two LLMs in the system. They do different things.

- **Orbit-side LLM** (static, cached, cheap): ambiguous segment classification; `recent_topics`, `outstanding_action_items`, `tone`. Writes into durable packet fields. Nightly cron. ~$520/founder/year. Track 4.
- **OpenClaw-side LLM** (dynamic, per-query): drafts, meeting prep briefs, semantic search, cross-agent coordination. Uses the packet as input. Outputs may flow back as observations. Founder's own API budget.

Full detail: [design spec §4](../docs/superpowers/specs/2026-04-18-orbit-v0-design.md).

## Data source status

| Source | State | Gotcha |
|---|---|---|
| WhatsApp | ✅ in ledger (33,105 rows) | NULs + unpaired UTF-16 surrogates in text break JSONB — sanitizer lives in [scripts/fast-copy-wacli-to-raw-events.mjs](../scripts/fast-copy-wacli-to-raw-events.mjs) |
| Gmail | ⚠️ connector exists (pre-prune), not in ledger | Widened to 12 mo; category-exclude at query |
| Google Contacts | ⚠️ `contacts.readonly` working; `contacts.other.readonly` pending | The `other` scope is additive; ~2–3× cross-source match rate when it lands |
| Calendar | ⚠️ works live via `gws calendar events list`; no ledger write path yet | — |
| Slack | ❌ in-memory only; no persistence | Connector exists but doesn't post to `raw_events` |
| Linear | ❌ same as Slack | — |

Full table: [design spec §8](../docs/superpowers/specs/2026-04-18-orbit-v0-design.md).

## Tech stack

- **Frontend + backend:** Next.js 16 (App Router, RSC, Turbopack). See the warning in [CLAUDE.md](../CLAUDE.md) — breaking changes from older Next versions; read `node_modules/next/dist/docs/` before writing route code.
- **Database:** Supabase Postgres (ledger, auth, observations). Connection strings in `.env.local`. Migrations applied via Supabase Management API, not via `supabase migration new` files.
- **Graph:** Neo4j Aura (persons + edges). Currently empty; Track 3.2 repopulates from `interactions`.
- **Auth:** Supabase session cookies for UI; agent API keys for plugin. Primitives in [src/lib/api-auth.ts](../src/lib/api-auth.ts).
- **Tests:** Vitest. 26 tests, ~1s full suite. `npm test`.

## Further reading

- Full design spec: [docs/superpowers/specs/2026-04-18-orbit-v0-design.md](../docs/superpowers/specs/2026-04-18-orbit-v0-design.md)
- Testing contract: [docs/superpowers/specs/2026-04-18-testing-and-verification.md](../docs/superpowers/specs/2026-04-18-testing-and-verification.md)
- Current state snapshot: [03-current-state.md](./03-current-state.md)
