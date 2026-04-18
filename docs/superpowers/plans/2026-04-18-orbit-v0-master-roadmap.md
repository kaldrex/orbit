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

## Track 1 — Week-1 pipeline fixes ✅ DONE, then retired

**Detailed plan:** archived at [docs/archive/plans/2026-04-18-track-1-pipeline-fixes.md](../../archive/plans/2026-04-18-track-1-pipeline-fixes.md)
**Goal at the time:** stop active data loss; close low-hanging pipeline bugs without architecture changes.

All four sub-tasks shipped as planned (INTERACTED edge provenance fields, Gmail availability hardening, `CO_PRESENT_IN` importer, LID→phone bridge scaffolding). Every artifact from this track was deleted in the 2026-04-18 clean-slate prune — the old `src/lib/neo4j.ts`, `src/lib/cypher/`, `scripts/import-group-participants.mjs`, `scripts/lid-bridge-nightly.mjs`, `packages/orbit-plugin/` are gone.

Why the work still mattered: it proved the old Neo4j-first pipeline was unsalvageable and forced the clean slate. See `outputs/verification-log.md` for the audit trail.

---

## Track 2 — raw_events ledger ✅ DONE

**Detailed plan:** archived at [docs/archive/plans/2026-04-18-track-2-raw-events-ledger.md](../../archive/plans/2026-04-18-track-2-raw-events-ledger.md)
**Goal:** make `raw_events` the immutable source of truth. Everything else becomes a projection.
**Exit criterion:** `SELECT COUNT(*) FROM raw_events` ≥ 30 000 from Sanchay's WA + re-import produces 0 new rows. **Met:** 33,105 rows, re-run inserts 0.

- [x] **2.1** Supabase migration: `raw_events` table + 7 indexes + unique constraint `(user_id, source, source_event_id)` — applied to prod 2026-04-18 via Management API
- [x] **2.2** `POST /api/v1/raw_events` endpoint with idempotent upsert — deployed to `orbit-mu-roan.vercel.app`, round-trip verified. Lives at [src/app/api/v1/raw_events/route.ts](../../../src/app/api/v1/raw_events/route.ts).
- [x] **2.3** ~~JSONL bootstrap importer~~ — redundant after 2.4 landed; script deleted in the clean-slate prune.
- [x] **2.4** wacli.db direct importer — [scripts/fast-copy-wacli-to-raw-events.mjs](../../../scripts/fast-copy-wacli-to-raw-events.mjs); 33,105 rows in ~10 s via direct Postgres `COPY`. Exports `wacliToRawEvents()` pure mapper.

---

## Track 2.5 — Plugin rewrite ⚠️ BLOCKING

**Detailed plan:** _pending._
**Goal:** fresh OpenClaw plugin that posts only to `/api/v1/raw_events`, reads only `/packet`, writes learnings through `/observation`. No signal-buffer, no direct Neo4j writes, no legacy protocol.
**Exit criterion:** plugin deployed to claw; live WhatsApp events land in `raw_events` within 500 ms per event; ingest lag < 5 min.

- [ ] **2.5.1** New plugin scaffold at `packages/orbit-plugin/`
- [ ] **2.5.2** WhatsApp connector → `raw_events`
- [ ] **2.5.3** Gmail connector → `raw_events`
- [ ] **2.5.4** Calendar / Slack / Linear connectors → `raw_events`
- [ ] **2.5.5** Deploy to claw; gateway running again

Ships in lockstep with Track 3 — no events flow anywhere until the plugin is rewritten.

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

- [x] **CC-1** Test infrastructure: Vitest configured, `npm test` runs in ~1 s, 26 passing
- [x] **CC-2** Fixtures committed: `tests/fixtures/wacli-minimal.db` + `tests/fixtures/golden-packets/` (Imran, Hardeep, Aryan Yadav). Gmail + Google Contacts fixtures land with Track 2.5 connectors.
- [x] **CC-3** `outputs/verification-log.md` — live and appended. Entries pre-2026-04-18 reference deleted artifacts (expected — audit history).
- [ ] **CC-4** Rollback rehearsal on Vercel prod — owed after Track 3 deploy lands.
- [ ] **CC-5** Nightly health cron on `claw` — after Track 5 (something worth monitoring).

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
| 2026-04-18 (AM) | Initial roadmap created alongside Track 1 plan. |
| 2026-04-18 (PM) | Track 1 landed. Track 2 plan + migrations + API + importers landed. Migrations applied to prod Supabase; Vercel prod redeployed; 33,105 real wacli messages backfilled via direct Postgres COPY in 10.77 s. Sub-item 2.5 (plugin rewrite) split off as open. Track 3 unblocked. |
| 2026-04-18 (evening) | **Clean-slate prune.** 96 files, −11,417 net LOC removed: 13 pre-pivot API routes, 5 `src/lib/*` fossils, 10 scripts, 5 test files, both plugin packages (`packages/orbit-plugin/`, `packages/openclaw-plugin/`). Neo4j graph wiped. Claw plugin service stopped + plugin dir removed. Track 1's artifacts no longer exist on disk but the learning landed. Track 2.5 escalated from "not blocking" to **blocking** — nothing is currently posting to the ledger. Track 1/2 detailed plans moved to `docs/archive/plans/`. Golden packets committed at `tests/fixtures/golden-packets/` as Track 3 acceptance target. Agent-context layer restructured into `CLAUDE.md` + `agent-docs/`. |
