# Orbit V0 — Master Roadmap

> **Source specs:** [2026-04-18-orbit-v0-design.md](../specs/2026-04-18-orbit-v0-design.md) · [2026-04-18-testing-and-verification.md](../specs/2026-04-18-testing-and-verification.md)

**Purpose:** top-level checklist tracking all six build tracks toward V0. Each track gets its own detailed plan under `docs/superpowers/plans/`. Check an item off here only when its detailed plan is complete AND the testing contract for that component is satisfied.

**Working definition of "done":** the corresponding row in the "V0 ready" checklist (spec §7) flips green AND an entry lands in `outputs/verification-log.md`.

---

## How to use this roadmap

1. Pick the topmost unchecked track that has no blocking dependency.
2. Open its detailed plan (link below) and execute tasks top-to-bottom.
3. Each commit on the track must cite an artifact in `outputs/verification/<date>-<slug>/` (per testing spec §8).
4. When all tasks in a track's plan are checked, flip its checkbox here.
5. Re-run `outputs/verification-log.md` nightly-report script to confirm no regressions.

---

## Track dependency graph

```
T1 (week-1 fixes) ─┐
T2 (raw_events)    ├─► T3 (projection + packet) ─┬─► T4 (LLM enrichment)
                   │                              └─► T5 (UI)
                   └────────────────────────────────► T6 (onboarding)
```

T1 and T2 are independent and can start in parallel. T3 depends on T2. T4 and T5 run in parallel once T3 lands. T6 depends on T1–T5 having a working pipeline end-to-end.

---

## Track 1 — Week-1 pipeline fixes

**Detailed plan:** [2026-04-18-track-1-pipeline-fixes.md](./2026-04-18-track-1-pipeline-fixes.md)
**Goal:** stop active data loss; close low-hanging pipeline bugs without architecture changes.
**Exit criterion:** gateway capability report on `claw` shows `channels=whatsapp,gmail,calendar` AND a rerun of `scripts/verify-graph.js` shows every edge has `source_event_id`, `thread_id`, `body_preview`.

- [x] **1.1** Preserve `source_event_id` / `thread_id` / `body_preview` / `direction` / `source` on `INTERACTED` edge
  - Already merged as commit [`aa44a40`](#). Verification test still needed — see plan Task 2.
- [ ] **1.2** Fix Gmail connector `isAvailable()` under gateway subprocess (hardcode PATH lookup)
- [ ] **1.3** Import `group_participants` as `CO_PRESENT_IN` edges (weight 0.1)
- [ ] **1.4** LID→phone bridge — nightly job scaffolding with seeded strong matches

---

## Track 2 — raw_events ledger

**Detailed plan:** _pending — write after T1 unit/integration tests are green._
**Goal:** make `raw_events` the immutable source of truth. Everything else becomes a projection.
**Exit criterion:** `SELECT COUNT(*) FROM raw_events` ≥ 30 000 from Sanchay's WA + ≥ 800 from wide Gmail, and re-import produces 0 new rows.

- [ ] **2.1** Supabase migration: `raw_events` table + indexes + unique constraint `(user_id, source, source_event_id)`
- [ ] **2.2** `POST /api/v1/raw_events` endpoint with idempotent upsert
- [ ] **2.3** Bootstrap: import existing JSONL exports into ledger
- [ ] **2.4** wacli.db direct importer (SQLite → raw_events bulk load)
- [ ] **2.5** Plugin rewrite: signal-buffer → raw_events (ledger-first, projection second)

---

## Track 3 — Projection + packet APIs

**Detailed plan:** _pending._
**Goal:** rebuildable `interactions` + `persons` + packet cache; serve read/write APIs.
**Exit criterion:** Neo4j projection rebuilds from raw_events in < 5 min; `GET /api/v1/person/:id/packet` returns valid JSON for top-50 persons matching golden fixtures.

- [ ] **3.1** Postgres view/job: `raw_events → interactions`
- [ ] **3.2** Neo4j projection job: `interactions → persons + edges`
- [ ] **3.3** Packet assembler: person + interactions + observations + enrichment
- [ ] **3.4** `GET /api/v1/person/:id/packet`
- [ ] **3.5** `POST /api/v1/person/:id/observation`

---

## Track 4 — LLM enrichment

**Detailed plan:** _pending._
**Goal:** static packet enrichment at ~$520/founder/year budget.
**Exit criterion:** nightly enrichment run populates `recent_topics`, `outstanding_action_items`, `tone` for top-200 persons; cost dashboard under budget.

- [ ] **4.1** `/internal/enrich/topics` — summarize last N messages per person
- [ ] **4.2** `/internal/enrich/outstanding_items` — extract open questions/asks
- [ ] **4.3** `/internal/enrich/classify_ambiguous` — segment for rule-16 fallback
- [ ] **4.4** Nightly cron wiring via `openclaw cron`

---

## Track 5 — Founder UI

**Detailed plan:** _pending._
**Goal:** ship the five tabs from spec §7 — Today, People, Person detail, Needs review, Search.
**Exit criterion:** dashboard first-paint < 2 s; Imran/Aryan/Hardeep cards render cleanly with zero console errors; responsive at 375 px / 768 px / 1440 px.

- [ ] **5.1** Card component matching Imran/Aryan/Hardeep layout
- [ ] **5.2** Today tab (going-cold, this-week, meeting prep)
- [ ] **5.3** People tab (grid + segment filter)
- [ ] **5.4** Person detail
- [ ] **5.5** Needs Review tab
- [ ] **5.6** Search
- [ ] **5.7** Dogfood on Sanchay's own Orbit E2E

---

## Track 6 — Onboarding

**Detailed plan:** _pending._
**Goal:** two founder onboarding paths converging on the same ingest pipeline.
**Exit criterion:** a new founder can connect in < 10 min and see ≥ 50 cards within the first hour.

- [ ] **6.1** "Already on OpenClaw" path — API-key paste + one command
- [ ] **6.2** "Fresh install" path — OpenClaw setup + per-source auth walkthrough
- [ ] **6.3** Installer script + CI smoke test

---

## Cross-cutting deliverables (not on a track, but required for V0)

- [ ] **CC-1** Test infrastructure: Vitest configured, `npm test` wired to CI, L1/L2 suites running under 5 min total
- [ ] **CC-2** Fixtures committed: `tests/fixtures/wacli-minimal.db` (~50 KB), `gmail-sample.jsonl` (~200 KB), `google-contacts-sample.json` (~30 KB), golden packets
- [ ] **CC-3** `outputs/verification-log.md` — every claim backed by an artifact row
- [ ] **CC-4** Rollback rehearsal on Vercel prod — `outputs/verification/2026-04-18-vercel-rollback-rehearsal.md` committed
- [ ] **CC-5** Nightly health cron on `claw` — plugin heartbeat, ingest lag, packet rebuild time

---

## Open questions / deferred decisions (from spec §10)

| Item | Status | Who unblocks |
|---|---|---|
| `contacts.other.readonly` scope | deferred — additive, any time | Sanchay (OAuth consent) |
| Constellation graph viz | deferred to post-V0 | — |
| In-app AI chatbot | explicitly NOT day-1 | — |
| Multi-tenant team agents | V2 | — |
| Mobile app | V2 | — |

---

## Changelog

| Date | Change |
|---|---|
| 2026-04-18 | Initial roadmap created alongside Track 1 plan. |
