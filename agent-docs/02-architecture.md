# 02 · Architecture

> The "how" at the level of intent. Read this before touching stores, routes, or projection.
> Exact column names, indexes, and thresholds are implementation — they evolve as we learn. This file describes *what each layer is for* and *why*.

## Two stores, one conceptual model

Orbit has two durable stores. Their responsibilities do not overlap.

| Store | Holds | Why here |
|---|---|---|
| **Supabase Postgres** | `raw_events` ledger, auth, `api_keys`, `profiles` | Immutable audit log + account data. Row-shaped, not relationship-shaped. |
| **Neo4j Aura** | `persons`, `edges`, `observations`, packet cache | The entire relationship layer. Graph-native queries (path-finding, cluster detection, intro-path, centrality) will live here — some now, some later. |

**No state drift** because there is no overlap. Every entity has exactly one home. Auth is never in Neo4j; persons are never in Postgres.

## Why Neo4j is load-bearing from day one

The product is a relationship memory. The data model is a graph. The roadmap has graph-native queries — community detection, intro-path recommendations, shared-cluster discovery, eventual cross-founder overlap — that are natural in Cypher and awkward in SQL.

Postgres-as-graph would work for today's shallow queries. It costs us Cypher ergonomics, built-in graph algorithms (GDS), and the moment-of-insight when a traversal query would have changed a product decision. Building on the right store now means no migration surprise later and the full graph toolbox available when we reach for it.

See [01-vision.md](./01-vision.md) "Build philosophy" — fit and correctness over speed-to-ship.

## Three API contracts

Everything agents or UI does goes through one of these.

### 1. Write events → `POST /api/v1/raw_events`

OpenClaw uploads raw source events in batches. Idempotent on `(user_id, source, source_event_id)` so replays are safe. Events land in the Postgres ledger; a projection step populates Neo4j `persons` + `edges`. Lives at [src/app/api/v1/raw_events/route.ts](../src/app/api/v1/raw_events/route.ts).

### 2. Read packet → `GET /api/v1/person/:id/packet`

Returns one human's full assembled record. Query-time join over Neo4j (persons + edges + latest observations) → JSON response. Read surface for UI and OpenClaw agents alike. The packet shape is the stable contract; its fields evolve. Not yet implemented.

### 3. Write observation → `POST /api/v1/person/:id/observation`

Typed, time-ordered, immutable learnings. Each observation carries a `kind`, a `value`, a `confidence`, a `source`, and `evidence`. Includes user corrections as a first-class kind. Observations feed packet assembly on read. Not yet implemented.

## The rules-as-tools surface

Rules are not a filter that runs before the LLM. Rules are **callable tools** OpenClaw's LLM invokes via function-calling. Orbit hosts the rule implementations and exposes them as HTTP endpoints under `POST /api/v1/rules/*` (the surface may evolve toward MCP — see open questions).

Illustrative tools OpenClaw's LLM could call:

- `classify_domain { domain }` — match against VC / press / gov / service lists
- `merge_candidates { person_ids }` — run name-waterfall + token-match logic
- `detect_going_cold { person_id }` — threshold logic over activity
- `normalize_phone { raw }` — E.164 canonicalization

**The LLM drives. Rules accelerate.** Server-side hosting means updates ship without redeploying every OpenClaw, and the logic stays auditable from one place.

## Data flow — intent, not mechanism

Two kinds of records arrive from OpenClaw during ingestion:

- **What happened** — source events, verbatim. Immutable, replayable. Any bug in inference is recoverable by re-running projection.
- **What was inferred** — observations. Confidence-scored, source-attributed, supersedable. Covers agent-derived insights (segment hints, topic summaries, tone) *and* human corrections.

The two kinds have different lifecycles, different trust levels, different re-processing semantics. How exactly OpenClaw uploads them — one stream with tagged records vs. two separate endpoints — is an open implementation question to be settled by experimenting on one connector end-to-end. See [07-data-flow.md](./07-data-flow.md) and [08-open-questions.md](./08-open-questions.md).

## Identity resolution — empirical, not theoretical

Cross-channel identity is the hardest problem in the product and the biggest potential moat. The previous build's ~1% cross-source match rate is the receipt.

The right approach is empirical: we don't know what the data actually looks like until we look. OpenClaw's LLM does the heavy inference against rich context (names, histories, content, patterns). Orbit's rule tools accelerate obvious deterministic cases (same phone → auto-merge, domain classification, phone normalization). Thresholds, fuzzy-match rules, and cluster-detection strategies are to be discovered from your real data — not prescribed from theory — and will evolve.

## Data source status

| Source | OpenClaw tool | Orbit ingestion status |
|---|---|---|
| WhatsApp | `wacli` | Ledger populated (33k rows from bootstrap); plugin streaming path TBD |
| Gmail | `gws` | Tool available; ingestion path not yet built |
| Google Contacts | `gws` | `contacts.readonly` working; `contacts.other.readonly` pending (2–3× cross-source match rate when it lands) |
| Calendar | `gws` | Live query works; ledger write path TBD |
| Slack | pending | No persistence path yet |
| Linear | pending | No persistence path yet |

## Tech stack

- **Frontend + backend:** Next.js 16 (App Router, RSC, Turbopack). Read `node_modules/next/dist/docs/` before writing route code — breaking changes from older Next versions.
- **Ledger + auth:** Supabase Postgres. Connection details in `.env.local`. Migration flow in [06-operating.md](./06-operating.md).
- **Graph:** Neo4j Aura. Env var gotcha: some deployments have literal `\n` suffixes on `NEO4J_URI`, `NEO4J_USER`, `NEO4J_DATABASE` — `.trim()` in every caller.
- **Auth primitives:** Supabase session cookies for UI, API keys for agents. See [src/lib/api-auth.ts](../src/lib/api-auth.ts).
- **Tests:** Vitest. Full suite under 1 second as of this writing.

## Further reading

- Product framing: [01-vision.md](./01-vision.md)
- Current state (what's on disk today): [03-current-state.md](./03-current-state.md)
- Data flow (bootstrap + monitoring): [07-data-flow.md](./07-data-flow.md) *(to be written)*
- Open implementation questions: [08-open-questions.md](./08-open-questions.md) *(to be written)*
- Operating rules: [06-operating.md](./06-operating.md)
