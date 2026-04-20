# 18 · Neo4j Edge Model Proposal

> Design for the graph projection that re-enables Neo4j as a first-class citizen alongside Postgres. Scoped to V0 data sources (WhatsApp + Gmail + Google Contacts). Postgres is the source of truth; Neo4j is a rebuildable projection. See [15-future-props.md](./15-future-props.md) "Why Neo4j is load-bearing" for the product case.

## Invariants

- `persons.id` (Supabase UUID) is the only stable identity. Neo4j `:Person.id` mirrors it.
- Populate is one-way: Postgres -> Neo4j. No write-back from Neo4j.
- Populate runs server-side behind the API (API-is-only-writer). No direct-Bolt client scripts.
- Populate is idempotent via `MERGE`. Re-running refreshes without duplicating nodes/edges.
- Multi-tenant: every node and edge carries `user_id`. Cypher reads always filter on it.

## Node model

### `(:Person)`

Projects from `persons` + latest-wins card (the same assembler `/person/:id/card` uses). Card fields travel as properties so Cypher can filter without round-tripping to Postgres.

| Property | Source | Type | Notes |
|---|---|---|---|
| `id` | `persons.id` | UUID string | Primary key. `MERGE (p:Person {id, user_id})`. |
| `user_id` | `persons.user_id` | UUID string | Tenant scope. Every query filters on this. |
| `name` | card | string or null | Latest-wins. |
| `category` | card | string or null | `founder`, `fellow`, `team`, `client`, `other`, ... |
| `company` | card | string or null | Enriched. |
| `title` | card | string or null | Enriched. |
| `relationship_to_me` | card | string or null | Enriched narrative. |
| `phone_count` | card | int | Length of `phones` (the list itself isn't indexed in Neo4j). |
| `email_count` | card | int | Length of `emails`. |
| `first_seen` | min observation `observed_at` | ISO8601 | |
| `last_seen` | max observation `observed_at` | ISO8601 | Powers going-cold queries. |
| `updated_at` | populate wall clock | ISO8601 | When this node was last refreshed. |

Indexes:
- `CREATE INDEX person_id_user FOR (p:Person) ON (p.id, p.user_id)` — primary lookup.
- `CREATE INDEX person_user_category FOR (p:Person) ON (p.user_id, p.category)` — category filters.
- `CREATE INDEX person_user_last_seen FOR (p:Person) ON (p.user_id, p.last_seen)` — going-cold queries.

Deliberately NOT on the node: phone/email arrays, observation ids, raw payloads. Those stay in Postgres. Neo4j holds only what graph algorithms and traversals need.

## Edge model

Three edge types, all `user_id`-scoped. All three are **undirected by data** (a shared group / DM / email thread is mutual) but Neo4j edges are directionally stored; queries use `-[:X]-` (undirected).

### `(:Person)-[:SHARED_GROUP]-(:Person)`

Derived from WhatsApp group co-membership. A single edge per (personA, personB, user_id) pair, regardless of how many groups they share — group list lives as a property.

| Property | Type | Notes |
|---|---|---|
| `user_id` | UUID | Tenant scope. |
| `group_ids` | string[] | The `@g.us` JIDs (and raw names for unbridged groups). Deduped. |
| `group_count` | int | `length(group_ids)`. Hot-path filter. |
| `weight` | float | See "Edge weights" below. |
| `updated_at` | ISO8601 | Populate run timestamp. |

### `(:Person)-[:DM]-(:Person)`

Derived from WhatsApp direct-message exchanges. Always 1:1. Collapsed to a single edge per pair.

| Property | Type | Notes |
|---|---|---|
| `user_id` | UUID | Tenant scope. |
| `message_count` | int | Total DMs across the history. |
| `first_at` | ISO8601 | Earliest DM. |
| `last_at` | ISO8601 | Most recent DM. Powers DM-based going-cold. |
| `weight` | float | See below. |

Practical note: in V0 the founder is one end of every DM edge. Multi-founder (Hardeep + Sanchay on same tenant pair) would introduce peer DM edges.

### `(:Person)-[:EMAILED]-(:Person)`

Derived from Gmail thread co-participation (both on the same thread, any header position). Collapsed per pair.

| Property | Type | Notes |
|---|---|---|
| `user_id` | UUID | Tenant scope. |
| `thread_count` | int | Number of shared Gmail threads. |
| `message_count` | int | Total messages across those threads. |
| `first_at` | ISO8601 | Earliest thread activity. |
| `last_at` | ISO8601 | Most recent thread activity. |
| `weight` | float | See below. |

## Edge weights

A single numeric `weight` per edge lets Cypher use the same property for shortest-path and centrality regardless of edge type. Proposed default formula (open to founder input — see questions below):

```
weight(SHARED_GROUP) = group_count
weight(DM)           = log10(1 + message_count) * recency_factor(last_at)
weight(EMAILED)      = log10(1 + thread_count) + 0.5 * log10(1 + message_count), both * recency_factor(last_at)

recency_factor(t) = exp(-days_since(t) / HALF_LIFE_DAYS)   // default HALF_LIFE_DAYS = 180
```

- Log scale tames power-law distributions (one mega-thread shouldn't dominate).
- Recency half-life makes stale edges fade without vanishing. 180 days = 6 months; tunable per founder.
- `SHARED_GROUP` intentionally has no recency term — group membership is binary state, not an event stream.

All three weights live on the same scalar so `shortestPath` with `relationshipWeight` works across edge types without normalization math inside the query.

## Idempotent populate semantics

The populate route is a POST that re-derives the full graph from Postgres and `MERGE`s it into Neo4j. Not incremental in V0 — re-run is cheap at 1,602 persons and safer than a dirty delta.

Pseudocode:

```cypher
// Phase 1: nodes
UNWIND $persons AS row
MERGE (p:Person {id: row.id, user_id: row.user_id})
SET p.name = row.name,
    p.category = row.category,
    p.company = row.company,
    p.title = row.title,
    p.relationship_to_me = row.relationship_to_me,
    p.phone_count = row.phone_count,
    p.email_count = row.email_count,
    p.first_seen = row.first_seen,
    p.last_seen = row.last_seen,
    p.updated_at = $run_at;

// Phase 2: edges (one phase per type)
UNWIND $shared_group_edges AS e
MATCH (a:Person {id: e.a_id, user_id: e.user_id})
MATCH (b:Person {id: e.b_id, user_id: e.user_id})
MERGE (a)-[r:SHARED_GROUP]-(b)
SET r.user_id = e.user_id,
    r.group_ids = e.group_ids,
    r.group_count = e.group_count,
    r.weight = e.weight,
    r.updated_at = $run_at;

// Phase 3: prune
MATCH (p:Person {user_id: $user_id})
WHERE p.updated_at < $run_at
DETACH DELETE p;

MATCH ()-[r:SHARED_GROUP|DM|EMAILED {user_id: $user_id}]-()
WHERE r.updated_at < $run_at
DELETE r;
```

Re-run behavior:
- Existing nodes/edges are updated in place (properties overwritten).
- Nodes or edges that disappeared from Postgres between runs are pruned by the `updated_at < run_at` sweep.
- A failed run leaves the graph in the prior consistent state (prune runs last; node/edge upserts are idempotent).
- Per-user scope: `$user_id` is always passed in, so one founder's re-populate never touches another's subgraph.

## Populate sourcing

- Nodes: `select_persons_page` + per-person `select_person_observations` -> assembleCard, feed card fields as node properties.
- `SHARED_GROUP` edges: currently derived from the manifest's `groups[]` array ([outputs/manifest-hypothesis-2026-04-19/orbit-manifest.ndjson](../outputs/manifest-hypothesis-2026-04-19/orbit-manifest.ndjson)). V1 will move this into Postgres as a projection off `raw_events` so the populate route doesn't touch disk artifacts.
- `DM` edges: derived from `interaction`-kind observations (channel=whatsapp, direction=dm). Today we don't consistently emit these; see open question below.
- `EMAILED` edges: derived from Gmail raw events once the thread-participant fan-out is implemented. Not available in V0.

**V0 populate can ship with SHARED_GROUP only.** DM and EMAILED land as the upstream data matures. The route contract is the same; the populate body grows.

## API surface (scaffolded, not wired)

Read routes (mirror `/api/v1/persons/enriched` auth + RPC pattern):

| Route | Purpose | Query shape |
|---|---|---|
| `GET /api/v1/graph/neighbors/:id` | 1-hop neighbors of person `:id`, optional edge-type filter | `MATCH (p {id})-[r]-(n) RETURN n, r` |
| `GET /api/v1/graph/path/:from/:to` | Shortest intro path between two persons | `shortestPath((a)-[*..4]-(b))` |
| `GET /api/v1/graph/communities` | Louvain community labels | `CALL gds.louvain.stream(...)` |
| `GET /api/v1/graph/centrality` | Betweenness or PageRank scores | `CALL gds.betweenness.stream(...)` |

Write route:

| Route | Purpose |
|---|---|
| `POST /api/v1/graph/populate` | Server-side rebuild of the graph projection for the authenticated user. |

All routes return `{ error: { code: "NEO4J_NOT_POPULATED", message: ... } }` with HTTP 503 until the populate is wired. The populate route itself returns `{ error: { code: "NOT_IMPLEMENTED" } }` with HTTP 501.

## Open product questions (need Sanchay's input)

1. **What makes an edge "worth it"?** Should we emit `SHARED_GROUP` for every shared group, or only for groups with < N members (e.g. skip 500-person megagroups where membership is noise)? Proxima Mumbai is signal; a 1,000-person alumni broadcast is not.
2. **Directedness.** `EMAILED`: treat `from -> to` as directed (captures who initiates) or collapse to undirected? Directed is richer but doubles edge count and complicates shortest-path. Proposal: undirected in V0, revisit when the UI exposes "who initiates" as a filter.
3. **Time-decay half-life.** 180 days is a guess. Founder's answer shapes going-cold UX: if Sanchay treats 90 days as "lost touch", half-life should match. If he keeps 2-year-old ties warm, 365+.
4. **Group-name vs JID edges.** Manifest has both `120363...@g.us` JIDs and human-readable names in the same `groups` array. Treat them as one bucket (dedup post-normalization) or separate? Names indicate older, unbridged groups; JIDs are canonical.
5. **Self-edges.** Does the founder's own `:Person` node participate in the graph, or do we exclude it? Excluding makes centrality meaningful (Sanchay being the most central is trivially true). Including lets "shortest path from me to X" be a normal `shortestPath` call. Proposal: include but tag `p.is_self = true` so algorithms can filter.
6. **EMAILED thread scope.** Founder is on every thread in his own Gmail — so every other participant gets an EMAILED edge to every other participant on that thread. A 20-person newsletter would emit C(20, 2) = 190 edges. Cap by participant count? Skip threads with list-headers? Need a concrete rule before the populate runs.
7. **DM weight when message_count is huge.** One group-chat equivalent DM thread can have 10,000+ messages. Log scale helps but founder may want "intensity bucketed" (daily/weekly/monthly) rather than raw count. Defer until we see the weight distribution post-populate.
8. **Community algorithm choice.** Louvain vs Leiden vs Label Propagation. Louvain is the default, Leiden is more stable. Depends on whether the UI surfaces community IDs directly (Leiden) or just uses them for coloring (Louvain is fine).

## Related

- [02-architecture.md](./02-architecture.md) — two-store model, API contracts.
- [15-future-props.md](./15-future-props.md) — Neo4j rationale, Cypher unlocks.
- [16-how-it-works-end-to-end.md](./16-how-it-works-end-to-end.md) §"What Neo4j will do" — Postgres-to-Neo4j projection sketch.
- [outputs/manifest-hypothesis-2026-04-19/](../outputs/manifest-hypothesis-2026-04-19/) — current source of shared-group edges.
