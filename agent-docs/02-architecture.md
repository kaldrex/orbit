# 02 · Architecture

> The "how" at the level of intent. Read this before touching stores, routes, or projection.
> Exact column names, indexes, and thresholds are implementation — they evolve as we learn. This file describes *what each layer is for* and *why*.

## Two stores, one conceptual model

Orbit has two durable stores. Responsibilities do not overlap.

| Store | Holds | Why here |
|---|---|---|
| **Supabase Postgres** | `raw_events` ledger, `observations`, `persons`, `person_observation_links`, `api_keys`, `profiles`, `auth.users` | Append-only audit-grade log of everything that ever happened + materialized projections + account data. Source of truth for writes. |
| **Neo4j Aura** | `persons` + `edges` (projection) — **currently empty, first-class in the architecture** | The graph-traversal layer. Multi-hop queries, intro-path finding, community detection, centrality — native to Cypher, awkward in SQL. Populated post-enrichment (see [15-future-props.md](./15-future-props.md)). |

**Postgres is source of truth; Neo4j is a projection.** Same pattern as CLAUDE.md: observations are source of truth, `persons` + Neo4j are projections.

## Why Neo4j is load-bearing

The product is a relationship memory. The data model is a graph. Distinctive product queries — "founders in my network reachable via someone I trust", "shortest intro path to X", community detection on shared-group edges — are one-liners in Cypher, multi-join nightmares in Postgres. At V0 scale (~1,602 persons) Postgres handles it; at scale or for deep traversal, Neo4j is essential. We keep it first-class so there's no migration surprise later.

See [01-vision.md](./01-vision.md) "Build philosophy" — fit and correctness over speed-to-ship.

## Five API contracts

Every write flows through one of these. Orbit never reads raw sources (WhatsApp, Gmail, etc.) — it's fed by OpenClaw skills running on the founder's machine. The API is the only writer.

### 1. Ledger ingress → `POST /api/v1/raw_events`

OpenClaw's plugins + the bulk backfill script post raw source events in batches. Idempotent on `(user_id, source, source_event_id)` so replays are safe. Lives at [src/app/api/v1/raw_events/route.ts](../src/app/api/v1/raw_events/route.ts). Current state: 33,105 WhatsApp rows parked; V0 runs from observations, not re-projection.

### 2. Observation basket → `POST` / `GET /api/v1/observations`

Append-only typed observations emitted by the observer / resolver / enricher SKILLs. Five kinds via a zod discriminated union: `interaction`, `person`, `correction`, `merge`, `split`. POST writes via `upsert_observations` RPC with a BEFORE-INSERT trigger computing a pgcrypto-based dedup key. GET is cursor-paginated read. A `kind:"merge"` observation triggers server-side materialization of the `persons` row + `person_observation_links`. Lives at [src/app/api/v1/observations/route.ts](../src/app/api/v1/observations/route.ts).

### 3. Card read → `GET /api/v1/person/:id/card`

Returns one human's assembled card — pure function of their linked observations (latest-wins + correction-override + Jaccard summary dedup). Card shape is the stable UI + agent contract; fields evolve. Lives at [src/app/api/v1/person/[id]/card/route.ts](../src/app/api/v1/person/[id]/card/route.ts); assembler at [src/lib/card-assembler.ts](../src/lib/card-assembler.ts).

### 4. Correction write → `POST /api/v1/person/:id/correct`

Human-authored corrections land as `kind:"correction"` observations with `confidence: 1.0`. Auto-linked to the target person_id by the RPC. Higher trust than any LLM guess. Lives at [src/app/api/v1/person/[id]/correct/route.ts](../src/app/api/v1/person/[id]/correct/route.ts).

### 5. Enriched persons list → `GET /api/v1/persons/enriched`

Cursor-paginated list of persons with non-placeholder category/relationship_to_me. Used by the manifest-generator's merge-back pass ("DB wins on interpretive fields, source wins on factual fields") to preserve enrichment across re-generation. Uses `select_persons_page` SECURITY DEFINER RPC. Lives at [src/app/api/v1/persons/enriched/route.ts](../src/app/api/v1/persons/enriched/route.ts).

## Rules-as-tools

Rules are **callable tools** OpenClaw's SKILLs invoke via function-calling, not a filter before an LLM. The `orbit-rules-plugin/` ships 10 modules (`safety`, `name`, `group-junk`, `bridge`, `forwarded`, `lid`, `phone`, `email`, `fuzzy`, `domain`). Each is a pure function tested against real-data fixtures.

- `safety` — 6 drop rules: phone-as-name, email-as-name, empty name, bot names, Unicode-masked phone, forwarded-chain artifact. Single enforcement point for both observer emission and bulk transform.
- `name.pickBestName()` — `messages.sender_name` fallback when `contacts.push_name` is empty.
- `group-junk` — mega-lurker + broadcast-ratio + commercial-keyword heuristics (annotates, doesn't exclude).
- `bridge` — cross-channel fuzzy-name bridge with `bareLid()` normalization.
- `forwarded` — vendor-on-foreign-domain stripping.
- `lid` — LID↔phone map lookup (14,995 pairs in session.db).
- `phone`/`email`/`domain` — canonicalization + classification.

**LLM drives. Rules accelerate.** All LLM judgment (category inference, `relationship_to_me` composition, topic/sentiment) stays inside observer/resolver/enricher SKILLs, funded by the founder's token budget. Rules are deterministic and ship server-side.

## Data flow — intent, not mechanism

Three record kinds flow in from OpenClaw:

- **What happened** — source events (`raw_events`). Verbatim, immutable, replayable.
- **What the agent inferred** — observations (`kind: person|interaction|merge|split`). Confidence-scored, source-attributed, supersedable.
- **What the human said** — corrections (`kind: correction`). First-class, trust=1.0.

The 80/20 split: ~80% of card-building work is deterministic (phone/email canonicalization, LID→phone bridge, bot filtering, dedup, bridge-based merges) and runs in rules. ~20% is interpretive (category, relationship_to_me, topic/sentiment) and runs in the founder's LLM turn.

## Identity resolution — empirical, not theoretical

Cross-channel identity is the hardest problem and the biggest potential moat. The 2026-04-16 pipeline hit ~1% cross-source match rate — a structural failure (6-pass greedy string-merge, zero LLM calls).

The V0 approach: per-person agentic resolution driven by the LLM, rules as tools. `bridge.mjs` (~2-hop fuzzy-name bridge) + `session.db.whatsmeow_lid_map` (14,995 LID↔phone pairs) give the deterministic layer a much higher ceiling than the old pipeline. Thresholds and cluster strategies are discovered from real data, not prescribed.

## Data source status

| Source | OpenClaw tool | Ingestion status |
|---|---|---|
| WhatsApp | `wacli` | `raw_events` bootstrap loaded (33,105 rows). Observations ingested via manifest-gen + Stage 5/5c/6. Continuous loop (Stage 7) pending. |
| Gmail | `gws` | Wide-export ingested (`~/.orbit-export/gmail-wide-*.messages.ndjson`). Continuous watch pending. |
| Google Contacts | `gws` | `contacts.readonly` export ingested. `contacts.other.readonly` scope deferred (2–3× cross-source lift when it lands). |
| Calendar | `gws` | Authorized; live query works. Ledger write path pending. |
| Slack · Linear | pending | No persistence path yet. |
| iMessage · Apple Contacts | deferred | Post-V0. |

## Tech stack

- **Frontend + backend:** Next.js 16 App Router + Turbopack. Read `node_modules/next/dist/docs/` before writing route code — breaking changes from older Next versions.
- **Ledger + auth + observations:** Supabase Postgres. Connection in `.env.local`. Migration flow in [06-operating.md](./06-operating.md). Supabase is a test/clone environment (`project_supabase_is_test_env.md`).
- **Graph:** Neo4j Aura (populated — 1,602 `:Person` nodes + 1,232 edges as of 2026-04-21). One-way projection from Postgres card data via `/api/v1/graph/populate`. Env var gotcha: some deployments have literal `\n` suffixes on `NEO4J_URI`, `NEO4J_USER`, `NEO4J_DATABASE` — `.trim()` in every caller. See [18-neo4j-edge-model-proposal.md](./18-neo4j-edge-model-proposal.md).
- **Auth primitives:** Supabase session cookies for UI, API keys for agents. See [src/lib/api-auth.ts](../src/lib/api-auth.ts).
- **Tests:** Vitest. **508 tests + 1 skipped across 35 files, full suite ~8 s.**

## Further reading

- Product framing: [01-vision.md](./01-vision.md)
- Current state: [03-current-state.md](./03-current-state.md)
- V0 pipeline narrative: [11-v0-pipeline-handoff-2026-04-19.md](./11-v0-pipeline-handoff-2026-04-19.md)
- Strategic inventory + Neo4j case: [15-future-props.md](./15-future-props.md)
- Operating rules: [06-operating.md](./06-operating.md)
