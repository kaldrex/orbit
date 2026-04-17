# Orbit — Hybrid Intelligence Vision

The thesis: **rules are evidence producers, not deciders. The agent decides.** Every rule exists to save tokens and narrow the LLM's search space — never to make the final call on identity, category, weight, or meaning. The graph should wake up every morning knowing more about the human's network than it did the night before, without the human lifting a finger.

---

## Part 1 — Record: What the system actually has

### 1.1 Connectors (5 live)

| Connector | Mechanism | Mode | What we pull | What we leave on the table |
|---|---|---|---|---|
| **Gmail** | `gws gmail users messages` CLI | Batch, 2h poll | From/To/Cc/Subject/Date | **Message body, attachments, thread context, labels-beyond-filtering, message-id** |
| **WhatsApp** | GOWA storage + `wacli` SQLite | Real-time webhook + batch bootstrap | Sender JID, chat JID, first-100-chars text, timestamp, group flag | **Media, quoted replies, participant metadata, full message, group name/subject** |
| **Calendar** | `gws calendar events list` CLI | Batch, 2h poll | Attendees, title, start time | **Description, location, conferencing, recurrence rules** |
| **Slack** | Webhook (bot) | Real-time only | User, text (first 100), timestamp | **Channel, thread, reactions, attachments, workspace context** |
| **Linear** | GraphQL API | Batch, 2h poll | Issue id, title, state, assignee | **Description, labels, estimate, team, project, priority** |

**Bootstrap gotcha:** Gmail `after:` with epoch 0 pulls only ~100 most recent (H7). Years of history silently dropped.

### 1.2 Pipeline

Signal → `SignalBuffer` (5s flush, 500 max, 5min dedup) → `POST /api/v1/ingest` → `batchUpsertPersons` → `batchResolveParticipants` (**name-only case-insensitive match**, [src/lib/neo4j.ts:249](src/lib/neo4j.ts:249)) → `batchCreateInteractions` (**+0.1 score, ceiling 10, no decay, no channel weight**, [src/lib/neo4j.ts:193](src/lib/neo4j.ts:193)) → Neo4j.

### 1.3 Registered tools (8)

Read: `orbit_lookup`, `orbit_person_card`, `orbit_going_cold`, `orbit_graph_stats`, `orbit_status`, `orbit_network_search`. Write: `orbit_ingest`, `orbit_log_interaction`.

**Missing:** `orbit_resolve_identities`, `orbit_categorize`, `orbit_enrich`, `orbit_ask` (natural-language graph Q&A), `orbit_merge_person`, `orbit_extract_topics`.

### 1.4 Background workers (both live)

- **PreMeetingBrief** — every 5min, calendar scan 20–30min ahead, composes via OpenClaw `/v1/chat/completions`, delivers via OpenClaw CLI
- **GoingColdDigest** — Monday 08:00, `/briefs?limit=5&days=14`, same gateway

### 1.5 LLM surface available but unused

- `LlmCategorizer` ([packages/orbit-plugin/lib/llm-categorizer.js](packages/orbit-plugin/lib/llm-categorizer.js)) — 181 lines, 10 categories matching `FILTER_TO_CATEGORY`, batch-20, gateway-backed. **Zero imports anywhere.**
- OpenClaw gateway — `POST /v1/chat/completions` only (OpenAI-compatible). No tool-use, no vision, no browser. But the plugin runs inside OpenClaw which DOES have browser + tool use — we can register tools that call the agent.
- `agent-browser` — available via Bash per CLAUDE.md. Never wired to the plugin.

### 1.6 Person schema fields, by fill rate

- Always: `id, userId, name, relationship_score (1–10), source, category (94% "other")`
- Sometimes: `email` (sparse on WhatsApp-only), `company` (derived from domain only)
- Almost never: `title, relationship_to_me, phone, linkedin, twitter, bio`

### 1.7 Interaction edge fields

`channel, timestamp, summary?, topic_summary?, relationship_context?, sentiment?` — the last four are accepted by the server but **no connector populates them**.

---

## Part 2 — Where rules broke (field evidence)

Forensics from live data + commits + docs. Each is a case for hybrid.

| # | Rule | Broke on | LLM wins because |
|---|---|---|---|
| 1 | Name-only dedup | `eric@anysphere.co` → 3 nodes (Eric Guo / Eric / Eric Bernstein). Email present on all; rule ignored it. | Reads all three, outputs canonical |
| 2 | No self-check in participant resolution | `p_8a9fbefc` "Sanchay" has 274 INTERACTED edges — every own message double-counted | Recognizes `profiles.self_node_id` + name/email → routes to canonical self |
| 3 | Hardcoded 113-domain newsletter blocklist | New domain = code change. False positives on "team@" internal | Context-aware ("this sender emails me back → human") |
| 4 | Toll-free regex `^91\d{5}00\d{3}$` | Single pattern, easily missed variants | Reads JID + name + message → "this is a business, not a contact" |
| 5 | Score +0.1 per interaction, ceiling 10 | 804 nodes stuck at 1–2 band, no variance | Weighs by channel, reciprocity, content density, recency |
| 6 | Category hardcoded to "other" on new person ([neo4j.ts:267](src/lib/neo4j.ts:267)) | 909/1003 uncategorized | Reads name + company + interaction pattern → category + confidence |
| 7 | Canonical resolver: first-name-match only when <5 chars | "Deep" vs "Deepak" collision but also misses "Shahid Shrivastava" ≠ "Ashutosh Shrivastava" on same email | Reads *context* of each, not just name strings |
| 8 | Calendar title split on `/` | `"1:1 with John / Brainstorm"` → picks "Brainstorm" as contact | Extracts named entities, ignores topic words |
| 9 | Multi-recipient email | 5 CCs = 5 independent score bumps | Recognizes broadcast vs directed |
| 10 | Group WhatsApp weighted same as DM | 85.7% of interactions are group noise | Distinguishes "broadcast" from "personal" |
| 11 | Hardcoded `SELF_NAMES = ["sanchay", ...]` in calendar connector | Next user installs plugin → sees Sanchay as their self | User profile bootstrap, not hardcoded |
| 12 | `after:0` Gmail bootstrap | Pulls 100 most-recent only, years silently dropped | Pagination is mechanical, but LLM can fill sparse history from available signal |

---

## Part 3 — Architecture: Hybrid by design

### 3.1 The four-tier separation

```
┌─────────────────────────────────────────────────┐
│  TIER 4 — USER-FACING                            │
│  Graph viz, agent chat, morning digest,          │
│  going-cold alerts, pre-meeting briefs           │
├─────────────────────────────────────────────────┤
│  TIER 3 — AGENT INTELLIGENCE                     │
│  LLM decides: identity, category, weight, topic, │
│  enrichment, narrative. Uses tools from Tier 2.  │
├─────────────────────────────────────────────────┤
│  TIER 2 — EVIDENCE PRODUCERS (rules)             │
│  Deterministic functions that produce structured │
│  evidence packets. Never decide — only surface.  │
├─────────────────────────────────────────────────┤
│  TIER 1 — RAW CAPTURE                            │
│  gws, wacli, GOWA, webhooks. Pull everything,    │
│  store faithfully, filter nothing lossy.         │
└─────────────────────────────────────────────────┘
```

### 3.2 Tier 1 — Gather

Principle: **capture lossless, filter at read time.**

- Add a `raw_interactions` store (Supabase table or object store) holding full email body, WhatsApp message, calendar description. Current `INTERACTED` edges keep only the summary — the rest is gone forever.
- Fix Gmail bootstrap pagination (H7).
- Capture labels, thread IDs, quoted-reply chains. These become features.
- Tag every raw signal with `(source, external_id)` so re-ingest is idempotent.

### 3.3 Tier 2 — Evidence producers (rules, kept narrow)

Rules survive where they're cheap and unambiguous. Their job is to produce **evidence** the agent then reads.

| Evidence type | Rule that produces it |
|---|---|
| `email_match(a,b)` | exact lowercased email |
| `phone_match(a,b)` | normalized E.164 |
| `abbreviation_candidate(a,b)` | "Ramon B" ↔ "Ramon Berrios" — first-name + initial |
| `reciprocity_ratio(person)` | sent/received count per channel |
| `cadence_pattern(person)` | weekly / monthly / sporadic |
| `group_copresence(a,b)` | shared WhatsApp groups, shared calendar events |
| `domain_signal(email)` | personal vs corporate vs newsletter-like |
| `self_reference(signal)` | matches `profiles.self_node_id` email or name |

Each evidence packet is small, typed, and **attached to a Person or edge as metadata**, not used to mutate state.

### 3.4 Tier 3 — Agent intelligence (the LLM does the deciding)

The agent runs in **passes**, each cheap and batched. Passes are pure functions of the current graph + evidence — idempotent, re-runnable, audit-logged.

**Pass A — Identity resolution** (runs after every bootstrap + nightly)
- Input: cluster of candidate Person nodes (from Tier-2 evidence: shared email, shared phone, abbreviation, first-name + shared interactor, domain + context)
- LLM receives 5–20 cluster candidates per call, decides merges with confidence ≥ 0.8
- Writes through `POST /api/v1/merge` with audit

**Pass B — Categorization** (new persons + "other" cleanup)
- `LlmCategorizer.categorizeBatch(20)` — rules resolve ~84% (domain heuristics), LLM handles 16%
- Writes via `PATCH /api/v1/persons/:id`

**Pass C — Relationship weighting** (replaces +0.1)
- Evidence: reciprocity, cadence, channel mix, recency, content density
- LLM outputs `relationship_score` in [0, 10] with reasoning stored
- Enables real dynamic range (the 93%-compressed-in-1-to-2 problem goes away)

**Pass D — Enrichment** (self-growing graph)
- Trigger: new person with email + sparse profile
- Tools available to the agent inside OpenClaw: `agent-browser` (public LinkedIn, company sites), web search
- Output: `title, company, bio, linkedin_url, twitter, public_notes`, sourced + timestamped
- **Conservative:** Only write fields with confidence ≥ 0.7, always keep provenance

**Pass E — Topic & intent extraction** (per interaction)
- For each new raw interaction with body: LLM returns `topics[], entities[], action_items[], sentiment`
- Stored on INTERACTED edge + aggregated on Person (`topic_distribution`)
- Cost-controlled: batch 20, sample 1-in-N for high-volume channels

**Pass F — Narrative layer**
- Weekly: "Here's your network this week — these 3 people went cold, these 2 are new and here's what I found about them, this person came up in 5 conversations this week across 3 channels"
- Stored as `journal` entries, surfaced in UI + morning digest

### 3.5 Tier 4 — User-facing

- Graph viz (already live) — add per-node `evidence` hover + `why this score` explainer
- `orbit_ask` tool: natural language → Cypher + narrative answer
- Morning digest: new persons enriched, clusters merged, anomalies detected
- Existing pre-meeting brief + going-cold already wired; feed them the richer data

---

## Part 4 — The self-enriching loop

```
    New signal
        │
        ▼
  Tier 1: raw capture (lossless)
        │
        ▼
  Tier 2: evidence packet generated
        │
        ▼
  Server upsert (name match + evidence attached)
        │
        ▼
  ┌───────── Async agent passes ─────────┐
  │ A: merge candidates? → /api/merge    │
  │ B: categorize if "other"             │
  │ C: re-score with evidence            │
  │ D: if sparse profile → enrich via web│
  │ E: extract topics/entities from body │
  │ F: update journal if material change │
  └───────────────────────────────────────┘
        │
        ▼
  Graph is now richer than yesterday,
  even if the human did nothing.
```

**Cadence:**
- A, B: after every bootstrap + nightly 02:00
- C: nightly 02:30
- D: on person creation + weekly backfill for sparse nodes
- E: on every new raw interaction (batched hourly)
- F: daily 07:00 (before morning digest)

---

## Part 5 — Agent-assist use cases this unlocks

Once the graph is this rich, the agent can answer questions like:

1. **"Who should I reconnect with this week?"** → going-cold, weighted by topic-relevance to what the user worked on recently (via Linear + calendar topics)
2. **"Intro me to someone who knows X at Y"** → `orbit_network_search` augmented with enriched company+title (from Pass D)
3. **"Summarize my relationship with Jane"** → narrative from topic distribution, sentiment trend, interaction cadence
4. **"Who came up in my conversations this week that I haven't followed up with?"** → Pass E entity extraction
5. **"Did I ever agree to send something to Ramon?"** → Pass E action items
6. **"Draft a reply to this email in my voice, with context"** → graph-aware Claude call
7. **"Show me the clusters in my network"** → community detection + LLM-generated cluster labels
8. **"Who do I know that just changed jobs?"** → Pass D re-enrichment delta
9. **"What's the state of the fundraising thread?"** → topic filter + timeline
10. **"Prep me for tomorrow's meetings"** → already live, now with richer context

---

## Part 6 — Priority order (ship-to-live)

1. **Stop the bleed in `batchResolveParticipants`** — add email/phone match ahead of name, and Supabase self-lookup. Without this, every new signal creates more work for every later pass.
2. **Pass A (identity resolver)** — rules + LLM orchestrator + `/api/v1/merge` + `orbit_resolve_identities`. Cleans the 18 email clusters + 509 fuzzy-name candidates.
3. **Self-dedup migration** — one-shot Cypher: merge `p_8a9fbefc` + `p_032f60cf` into `user_728032c5`.
4. **Pass B (categorization)** — wire `LlmCategorizer`, expose `orbit_categorize`, auto-run post-bootstrap.
5. **Lossless raw capture** — new Supabase `raw_interactions` table, extend connectors to store full body. Nothing downstream breaks; future passes have material to work with.
6. **Pass E (topic extraction)** — depends on #5.
7. **Pass C (re-score with evidence)** — replaces +0.1. Requires #5+#6.
8. **Pass D (web enrichment)** — `agent-browser` hook, LinkedIn/company lookup.
9. **Pass F (narrative)** — journal + morning digest content.
10. **`orbit_ask`** — NL → Cypher + narrative.

Each ships live before the next starts.
