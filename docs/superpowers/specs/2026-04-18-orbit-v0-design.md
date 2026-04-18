# Orbit V0 — Design Spec

**Date:** 2026-04-18
**Status:** Approved architecture, ready for implementation planning
**Source material:** See the three hypothesis-test runs under `outputs/hypothesis-test-20260418{,-v2,-v3}/` for the empirical validation that grounds every claim in this doc.

---

## 1. Product model

**Who it's for:** founders.

**What it does:** gives the founder a unified relationship memory across the channels they already use (WhatsApp, Gmail, Calendar, Slack, Linear). One card per human, gathered from everywhere.

**The three-way loop:**

```
          HUMAN (the trigger)
             │
             ▼
         OpenClaw ◀─────────── Orbit
          (hands)               (memory)
             │                    ▲
             │                    │
             └─── observations ───┘
```

- **OpenClaw** (runs on the founder's machine) owns channel connections, acquisition, and real-time agent work.
- **Orbit** (hosted) owns canonical memory, identity resolution, packets, LLM-enriched summaries, and the founder-facing UI.
- **The human** triggers activity. Each action the agent takes generates observations that flow back into Orbit, making the memory richer. No activity, no compounding.

**The unit of value: the person packet.** Not the graph, not the feed — the single structured record that describes one human's cross-channel presence, relationship state, and context. See `outputs/hypothesis-test-20260418-v3/person_packet_{imran,hardeep,aryan_yadav}.json` for the canonical examples that ground this spec.

---

## 2. Architecture

**Three durable layers on the server (the inversion):**

1. **`raw_events`** — immutable append-only ledger, one row per source-event. Handoff-prescribed schema: `source`, `source_event_id`, `channel`, `occurred_at`, `ingested_at`, `direction`, `thread_id`, `participants_raw`, `participant_phones`, `participant_emails`, `body_preview`, `attachments_present`, `connector_version`, `raw_ref`. Idempotent on `(user_id, source, source_event_id)`.
2. **`interactions`** — deterministic projection from `raw_events`. One row per cross-source interaction with identity resolved. Rebuildable from `raw_events` alone.
3. **`persons` + packet cache** — canonical entities with aliases, segment, relationship stats, LLM-enriched context. Rebuildable from `interactions`. Stored in Neo4j (for graph queries) + Postgres cache (for fast packet reads).

**Why inverted:** if rules change, schema changes, or a new field is added, we rebuild from `raw_events` without re-fetching from source. Today's architecture can't do this — it goes source → Neo4j one-shot and ~40% of audit fields are dropped at the boundary.

**Two control surfaces:**

- Orbit serves `GET /api/v1/person/:id/packet` — read path for both UI and OpenClaw agents.
- Orbit accepts `POST /api/v1/person/:id/observation` — write-back path for OpenClaw agents to flow new signal in (tone, segment hints, merge candidates, snoozes, corrections).

**Control plane for jobs (don't rebuild):** OpenClaw already provides `openclaw tasks` + `openclaw cron` + `openclaw acp`. Orbit enqueues backfill/reprocess jobs through these; the plugin registers handlers. No custom job queue.

---

## 3. Classification rules (first-match-wins)

Same rules run for every founder. Personalization comes from whose data flows through. The `family` rule uses the founder's own surname as input; the `teammate` rule uses their own email domain — automatic adaptation, zero config.

| # | Rule | Test |
|---|---|---|
| 1 | Self | Matches the founder's own identifiers |
| 2 | Family | Surname token matches the founder's surname |
| 3 | Automated | Name/email contains `noreply / support / alerts / system / mailer` |
| 4 | Service | Domain in known list (hdfc, amazon, uber, razorpay, jio, stripe, ...) |
| 5 | Investor | Domain in VC list (a16z, sequoia, accel, lightspeed, peakxv, ...) |
| 6 | Press | Domain in media list (economictimes, ndtv, techcrunch, ...) |
| 7 | Teammate | Same email domain as the founder |
| 8 | Peer | Personal domain + 2-way WA + ≥3 msgs |
| 9 | Acquaintance | Sparse: 1 msg, no reply |
| 10 | → LLM | Nothing matched |

Rules fire in order; first match wins. Validated on Sanchay's data: rules covered 98.8% of active persons, LLM fallback needed for ~20% of fine-grained distinctions.

---

## 4. Rules vs. LLM responsibility split

**Orbit-side LLM (static enrichment, cached, cheap):**
- Ambiguous segment classification (the 20% not caught by rules 1-9)
- `recent_topics` — summarize recent messages per person (nightly)
- `outstanding_action_items` — extract open questions/asks (nightly)
- `tone` — directness, warmth, formality (weekly)

Bounded cost: ~$0.05/person × 200 active people = ~$520/founder/year. Predictable.

**OpenClaw-side LLM (dynamic, per-query, founder's own model):**
- Drafting replies
- Meeting prep briefings
- Semantic search interpretation
- Cross-agent coordination

Cost is the founder's own API bill. Uses the packet as input; does not need raw message bodies.

**Key property:** Orbit's LLM writes into durable packet fields. OpenClaw's LLM produces one-shot outputs that may flow back as observations.

---

## 5. Identity resolution & name waterfall

**Name waterfall (in priority order):**
1. Google Contacts `displayName` matched by canonical E.164 phone
2. wacli `full_name`
3. wacli `push_name`
4. wacli `first_name`
5. `business_name`
6. → **Side bucket** ("Needs review")

**Identity merge rules:**
- Deterministic: same canonical phone, same email, or same JID → auto-merge
- Pattern: Google Contacts name-token bridge from WA phone to Gmail sender
- Fuzzy: Levenshtein ≤2 on ≥2 normalized tokens → human-review queue
- Never auto-merge on single-token collisions (avoids the `Jain`/`Yadav` false-positive class)

**The side bucket is a first-class concept.** Bare-JID contacts stay out of the main graph, keep all message history, show a grid with phone + last-preview + volume so the founder can triage. As names arrive (new Google Contacts entries, push_name updates, cross-source inference), they graduate out automatically.

Validated on Sanchay's data: 160/162 active persons (98.8%) got a displayable name through this waterfall. 9,836 `@lid` anonymous contacts correctly sit in the side bucket.

---

## 6. The observation feedback loop

One endpoint, one shape:

```
POST /api/v1/person/:id/observation
{
  "kind":       "tone_update" | "segment_hint" | "merge_candidate"
              | "snooze" | "topic_tag" | "intro_chain" | "correction",
  "value":      {...},
  "confidence": 0.0-1.0,
  "source":     "agent_draft_accepted" | "agent_research" | "user_correction" | ...,
  "evidence":   "what the agent saw that caused this"
}
```

Observations are time-ordered, immutable, and merged into packets on a schedule. Each observation has a confidence score and a source; bad ones can be suppressed. Good ones accumulate.

This is the mechanism by which every hour of agent use makes the memory sharper. No observations = no compounding.

---

## 7. V0 scope

**Ship V0 as:** "Orbit gives you a unified card for every person you actually have cross-app activity with. Today, 9 real people. Grows as signal accumulates."

**Features (what the founder actually uses):**
1. **Today** — going-cold alerts, this-week activity, prep brief when a meeting is ~20 min out
2. **People** — scrollable grid of cards, sorted by relationship intensity, filterable by segment
3. **Person detail** — the full card (see `person_packet_*.json` examples)
4. **Needs review** — the side bucket, with triage flow
5. **Search** — "everyone from X" / "gmail.com contacts I haven't touched in a month"

**Demo anchors** (all real, from Sanchay's data):
- **Imran Sable** — cross-source work partner, RISING trend, 2 emails linked to 1 phone
- **Aryan Yadav** — going-cold (18d quiet), 150 interactions, specific unanswered questions preserved
- **Hardeep Gambhir** — internal teammate, 21 shared WhatsApp groups materialized from `group_participants`

---

## 8. Data source status

| Source | State | Notes |
|---|---|---|
| WhatsApp | ✅ solid | `wacli.db` direct read (33k rows, 0 lossy). Import `messages`, `chats`, `contacts`, `group_participants` |
| Gmail | ⚠️ config | Widened 12mo + category-exclude at query. Live on gateway has a PATH bug (see Week 1) |
| Google Contacts | ⚠️ scope | `contacts.readonly` working. `contacts.other.readonly` pending — will 2-3× cross-source |
| Calendar | ⚠️ not at rest | `gws calendar events list` works live. Needs ledger write path |
| Slack | ❌ no persistence | Connector exists; emits in-memory. Add ledger write |
| Linear | ❌ no persistence | Same |

---

## 9. Build plan — 6 tracks

Grouped by dependency. T1/T2 can start immediately; T3 unblocks T4 and T5.

**Track 1 — Week-1 pipeline fixes (no architecture changes):**
- Fix Gmail connector availability check (`execFileSync("which","gws")` fails in gateway subprocess — hardcode `/usr/bin/gws` or pass full PATH env)
- Preserve `source_event_id`, `thread_id`, `body_preview` on existing `INTERACTED` edge (stops active data loss while ledger is built)
- Import `group_participants` as `CO_PRESENT_IN` edges (weight 0.1, never as primary relationship signal)
- LID→phone bridge as a nightly job (seeded with the 35 strong matches already found)

**Track 2 — raw_events ledger (Week 2-3):**
- Supabase migration: `raw_events` table
- `POST /api/v1/raw_events` endpoint with idempotent upsert on `(user_id, source, source_event_id)`
- Bootstrap: import existing JSONL exports into the ledger
- wacli.db direct importer: bulk-load from SQLite into raw_events
- Plugin rewrite: signal buffer → raw_events (ledger-first, projection second)

**Track 3 — Projection + packet (Week 3-4):**
- Postgres view/job: `raw_events → interactions`
- Neo4j projection job: `interactions → persons + edges`
- Packet assembler: combine person + interactions + observations + enrichment fields
- `GET /api/v1/person/:id/packet`
- `POST /api/v1/person/:id/observation`

**Track 4 — LLM enrichment (Week 4-5):**
- `/internal/enrich/topics` — summarize last N messages per person
- `/internal/enrich/outstanding_items` — extract open questions/asks
- `/internal/enrich/classify_ambiguous` — segment for rule-10 leftovers
- Nightly cron via `openclaw cron`, cached in packet

**Track 5 — UI (Week 4-5, parallel with T4):**
- Card component matching the Imran/Aryan/Hardeep layout
- Today / People / Needs Review tabs
- Search
- Dogfood on Sanchay's own Orbit end-to-end

**Track 6 — Onboarding (Week 6):**
- "Already on OpenClaw" path: API-key paste + one command
- "Fresh install" path: walkthrough for OpenClaw setup + per-source auth
- Both converge on the same ingest pipeline

---

## 10. Decisions made / deferred

**Made:**
- Inverted storage — raw_events ledger is primary, Neo4j is a rebuildable projection
- LLM split — Orbit does static enrichment, OpenClaw does dynamic reasoning
- Rule list — 10 rules, same for all founders, auto-adapt via founder's own identifiers
- Side bucket for unnamed — don't hide, don't surface in main graph
- Drop WA group messages from interactions, keep membership as weak `CO_PRESENT_IN`
- V0 framing: "unified cards for cross-app people" (not "unified graph"), narrow and honest
- Observation feedback is the moat, not the graph DB

**Deferred:**
- `contacts.other.readonly` scope — additive, ~2-3× cross-source. Any time.
- Visual "constellation" graph — nice to have, not day-1
- AI chatbot inside Orbit — not day-1; OpenClaw agents are the interface
- Multi-tenant team agents — V2
- Mobile app — V2

---

## References

- Hypothesis validation reports (real data):
  - `outputs/hypothesis-test-20260418/REPORT.md` — 7 hypotheses, 3 confirmed / 4 broken
  - `outputs/hypothesis-test-20260418-v2/REPORT_V2.md` — post Google Contacts
  - `outputs/hypothesis-test-20260418-v3/REPORT_V3.md` — post Gmail widening
- Canonical packet examples: `outputs/hypothesis-test-20260418-v3/person_packet_*.json`
- Prior handoff docs that informed this: `docs/handoff/{06,07,08}-*.md`

---

**Bottom line:** Orbit is the founder's relationship memory. OpenClaw is the hands. Every time the hands do work, the memory gets better. This spec is how we build the tech that supports that loop cleanly and compounding.
