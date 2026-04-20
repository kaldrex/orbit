# 15 · Future Props — data sources, improvements, continuous-loop

> Strategic inventory captured 2026-04-20 during Stage-6-v4 enrichment. Answers four questions: (1) what's the end goal, (2) what data sources do we have vs. could have, (3) what could be better across CLIs / code / tool-calling / parsing, (4) how do people keep getting added once the product is live.

## The goal (crisp)

**A living, queryable map of every human you have signal with — so you can surface the long tail you'd otherwise forget.** Not the 30 you remember. The 1,600+ you've touched.

Concrete questions the product should answer in one click:
- *"Who founded a company in the last 2 years?"*
- *"Who haven't I spoken to in 60 days but I used to regularly?"*
- *"Who's based in Dubai and also founder-stage?"*
- *"Who do I know through both Umayr and the Proxima Mumbai group?"*

See also: `memory/project_orbit_is_discovery_not_directory.md`, `memory/project_map_first_queries_second.md`.

## Sources + info — inventory

### Using today

| Source | What we pull | Fills |
|---|---|---|
| WhatsApp (wacli) | messages, contacts, chats, groups, group_participants, session.db LID map | names, phones, group membership, DM thread counts |
| Gmail (gws) | headers (From/To/Date/Subject/List-Unsubscribe), top 5 thread bodies | emails, thread counts, company domain signal |
| Google Contacts (gws) | display names, phones, emails (sparse — check gws field mask) | name enrichment, cross-channel identity bridge |

### Not using today — potential big wins

| Source | Unused signal | Value |
|---|---|---|
| WhatsApp | **Call metadata** (who called whom, duration) | Strong relationship-intensity signal |
| WhatsApp | **Reply-to chains** | Direct conversational intent |
| WhatsApp | **Business profiles** | Category hint (business = likely sponsor/vendor) |
| WhatsApp | **Reactions** | Engagement intensity per thread |
| WhatsApp | **Status viewers** | Who's actively watching your life (asymmetric signal) |
| Gmail | **Attachments** | Shared docs → working-together signal |
| Gmail | **Labels** (starred, important) | Your own historical judgment, already encoded |
| Gmail | **Thread reply-context** | X replied to Y's specific message |
| Google Contacts | **Organization + title fields, birthday, address, notes** | Company + title without inference |
| All channels | **Message body NER** | "Hi I'm Rohit, I work at Stripe" → extracts identity + affiliation |

### Planned but not wired

Calendar · Slack · iMessage · Linear · Twitter/X (if founder has API).

## Better CLIs / code / tool-calling / parsing

### Better CLIs — verbs to add

Current orbit-cli has 4 (`observation_emit`, `observation_bulk`, `person_get`, `persons_list_enriched`). Target surface:

| Verb | What it does |
|---|---|
| `orbit person search "<query>"` | Semantic search — "who's at Stripe" |
| `orbit person neighbors <id>` | Who do I know through this person |
| `orbit person going-cold --days 90` | Dormant-tie surfacing |
| `orbit block-email` / `block-name` / `merge` | Curation (Stage 2 deferred) |
| `orbit person correct <id> --field X --value Y` | Founder overrides |
| `orbit person retract <id>` | Soft-delete |
| `orbit stats` / `orbit doctor` | Health + counts |

### Better code — close the tracked debt

From `memory/project_tracked_debt_2026_04_20.md`:
1. CI pipeline (tests run remotely before merge)
2. Error monitoring on deployed API (Sentry or similar)
3. Fix `.min(2)` schema quirk properly — emit per-channel person observations so merges naturally have 2+
4. Neo4j re-enablement — consider at ~50k humans or deep graph traversal
5. Extract enricher into a proper plugin with tests + resumability + telemetry

### Better tool-calling for OpenClaw

- **`/tools/invoke` for deterministic reads** — no agent-loop ceremony (~3-4 min/person savings vs agent turns)
- **OpenProse `session with context:`** for batch LLM work — proven in Stage 6-v3 (1,568 in 11min, $4)
- **Pad system prompts past 2,048 tokens** so Sonnet cache fires (50% cost cut)
- **Sonnet for structured extraction, Opus only for ambiguous multi-hop reasoning** — quality is comparable, cost isn't
- **Register Orbit-specific OpenProse skills** for common workflows (observer, enricher, resolver)

### Better parsing

- Named-entity extraction on message bodies (companies, events, locations mentioned)
- Pull Google Contacts `organization` + `birthday` + `address` fields (may already be in export — verify)
- Self-introduction extraction from group messages ("Hi, I'm X") — link LID → name automatically
- Call-log ingestion for WhatsApp (strong signal, cheap pull)

## How people keep getting added (Stage 7 — continuous loop)

### Today's gap

Orbit's DB is a snapshot of 2026-04-20. New messages after today don't update any card. Without Stage 7, Orbit dies the day manual re-runs stop.

### V0 shape (single founder)

1. **Trigger:** new WhatsApp message or new Gmail arrives
2. **Hook:** OpenClaw's `heartbeat` + `cron` primitives (every 15 min, scan `wacli.db` for new messages since last watermark)
3. **Observer fires** on the sender → emits new observations (identity + interaction + maybe correction)
4. **Resolver reconciles** against existing persons (bridge-aware merger catches "same human, new signal")
5. **Card auto-updates** via append-only observations + latest-wins card assembly
6. **LLM re-enrichment** opportunistically: if signals changed significantly OR card hasn't been re-enriched in 14 days, batch it into next enrichment cron

### Multi-founder shape (Hardeep, chad)

- Each founder's claw runs their own cron scanning their own channels
- Shared Orbit API (multi-tenant via RLS — already wired)
- Observer skills are generic — no hardcoded Sanchay-isms (already fixed via `ORBIT_SELF_EMAIL`)
- Shared OpenClaw skill-pack (npm-distributed) — install once, works for any founder

### The compounding moment

Once Stage 7 is wired, Orbit grows itself. Every WhatsApp group you join adds members. Every email sender becomes a card. Every correction propagates backward through the ledger.

## Why Neo4j is load-bearing (not optional)

**Original architecture placed Neo4j as the persons + edges store.** Since the April wipe we've been running Postgres-only because at 1,602 nodes it handled V0 queries fine. **That was a scale-time call, not a product-shape call.**

Re-examined 2026-04-20 — conclusion: **Neo4j belongs back in the architecture as a first-class citizen**, not because we've outgrown Postgres, but because **our data IS a graph and our distinctive queries are graph queries.**

### The shape argument

- **Nodes** = humans (persons)
- **Edges** = `KNOWS` (shared WA group), `DM` (direct messaged), `EMAILED` (Gmail thread with)
- **Distinctive product queries** = multi-hop traversal, intro-path finding, community detection, centrality — all native to graph DBs, awkward to express in SQL

### Concrete Cypher unlocks (working with enrichment we already have)

```cypher
// "Founders in my network who've shipped a product,
//  reachable via someone I already know well"
MATCH (me)-[:KNOWS*1..2]-(f:Person {category: 'founder'})
WHERE f.relationship_to_me CONTAINS 'launched'
   OR f.relationship_to_me CONTAINS 'shipped'
RETURN f.name, f.company, f.relationship_to_me
```

```cypher
// "Shortest intro path from me to person X"
MATCH path = shortestPath(
  (me:Person {id:'sanchay'})-[:KNOWS*1..4]-(target:Person {name:'Elon Musk'})
)
RETURN [p IN nodes(path) | p.name]
```

```cypher
// "Auto-cluster my network into communities"
CALL gds.louvain.stream('my-graph') YIELD nodeId, communityId
```

```cypher
// "Who's most central — the hubs bridging otherwise-separate groups"
CALL gds.betweenness.stream('my-graph') YIELD nodeId, score ORDER BY score DESC
```

Each is one query in Cypher. In Postgres they're either impossible or multi-join nightmares.

### The split (correct architecture)

| DB | Role |
|---|---|
| **Postgres** | Append-only observation ledger. Audit-grade, SQL-native, where writes land. Source of truth. |
| **Neo4j** | Projection of the graph. Persons + edges + algorithms. Where graph-reads happen. |

Same pattern as CLAUDE.md's three-contracts story: **observations are source of truth; persons + Neo4j are projections.** Each store does what it's designed for.

### Concrete data point that made this case clear

A single enriched founder card from Stage 6-v4:

```json
{
  "name": "Yash Rane", "category": "founder",
  "relationship_to_me": "Founder of NyayAssist, an Indian legal-tech product,
    who shares the Aurum workforce and Deep Blue Season 8 groups with Sanchay
    and has publicly announced the product's launch.",
  "company": "NyayAssist", "title": "Founder"
}
```

With 31 founders enriched like this and Neo4j loaded, the question *"founders I know who've shipped, reachable via someone I trust"* becomes a one-liner. Without Neo4j, it's a scraping exercise through Postgres JSONB.

### Plan

1. Populate Neo4j from `persons` + manifest's shared-group edges (~2 hrs). Idempotent.
2. Add `/api/v1/graph/*` routes: `neighbors/:id`, `path/:from/:to`, `communities`, `centrality`.
3. CLI verbs wrap them: `orbit person neighbors <id>`, `orbit path me-to <id>`, `orbit communities`.
4. Stage 8 UI graph view is Neo4j-backed **by construction**, not retrofit.

**Status in memory:** `project_tracked_debt_2026_04_20.md` previously had Neo4j as "deferred indefinitely." **Revised position: next load-bearing step post-enrichment.**

## Priorities (as of 2026-04-20)

1. **Finish Fix #1 currently running** — LID bridge, ~1,000 cards upgrade from "other" to real categories
2. **Stage 7 continuous loop** (~½ day) — the "living" part of the product
3. **Stage 8 UI** (~1 afternoon) — you can actually see + filter
4. **Unused WhatsApp signals** — calls, business profiles, reactions
5. **Multi-founder onboarding** — Hardeep, chad
6. **Backlog:** curation verbs, search, neighbors, going-cold

**Highest-leverage after Fix #1: Stage 7.** Without it, the product is frozen in time.

## Related

- [14-cleanup-2026-04-20.md](./14-cleanup-2026-04-20.md) — post-audit cleanup narrative
- [13-multi-tenant-onboarding.md](./13-multi-tenant-onboarding.md) — Hardeep/chad onboarding plan
- [12-junk-filtering-system.md](./12-junk-filtering-system.md) — blocklist architecture
- `memory/project_tracked_debt_2026_04_20.md` — 4 open debt items tracked
- `memory/project_orbit_is_discovery_not_directory.md` — product thesis
