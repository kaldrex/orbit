# 04 · Roadmap

> Where we are in the six-track plan. Update when a track flips status. Detail lives in the master roadmap — this is the pointer view.

Master: [docs/superpowers/plans/2026-04-18-orbit-v0-master-roadmap.md](../docs/superpowers/plans/2026-04-18-orbit-v0-master-roadmap.md).

## Dependency graph

```
T1 (pipeline fixes) ─┐
T2 (raw_events)      ├─► T3 (projection + packet + observation) ─┬─► T4 (LLM enrichment)
                     │                                            └─► T5 (UI)
                     └─ T2.5 (plugin rewrite) ───────────────────► T6 (onboarding)
```

T2.5 (plugin rewrite) used to be "open, not blocking." After the clean-slate prune, the old `/api/v1/ingest` route is gone and the claw gateway is stopped. T2.5 now ships in lockstep with T3.

## Status

| # | Track | Status | Exit criterion |
|---|---|---|---|
| 1 | Week-1 pipeline fixes | ✅ done (code). Pre-pivot fossil removed; the INTERACTED-edge work paid off by proving the old path was unsalvageable. | n/a — retired with the old graph |
| 2 | `raw_events` ledger | ✅ done | `SELECT COUNT(*) FROM raw_events ≥ 30k` + re-import inserts 0. **Met**: 33,105 rows. |
| **2.5** | **Plugin rewrite** | ⚠️ **blocking** | Fresh plugin posts to `/api/v1/raw_events` only. Reads `/packet`. Writes `/observation`. All five source connectors (WhatsApp, Gmail, Calendar, Slack, Linear) ledger-first. |
| **3** | **Projection + packet + observation** | ⏳ **next** | Neo4j projection rebuilds from `raw_events` in < 5 min. `GET /packet` returns JSON diff-clean against the three fixtures in [tests/fixtures/golden-packets/](../tests/fixtures/golden-packets/). `POST /observation` round-trips and shows up in the next packet read within 30 s. |
| 4 | LLM enrichment | ⏳ blocked on T3 | Nightly run populates `recent_topics`, `outstanding_action_items`, `tone` for top-200 persons. Cost dashboard under ~$520/founder/year. |
| 5 | Founder UI | ⏳ blocked on T3 | All five tabs (Today · People · Person detail · Needs Review · Search) render live data from `/packet`; Imran/Aryan/Hardeep cards visually correct; first-paint < 2 s. |
| 6 | Onboarding | ⏳ blocked on T1–T5 | New founder connects in < 10 min and sees ≥ 50 cards within the first hour. Two paths: API-key paste (existing OpenClaw) + fresh install. |

## Track 3 sub-tasks

| # | Sub-task | Where it lives | Acceptance artifact |
|---|---|---|---|
| 3.1 | Postgres projection `raw_events → interactions` | new Supabase migration + view/materialized view | count(interactions) matches expected from 33 k WA rows, rebuild time < 30 s |
| 3.2 | Neo4j projection `interactions → persons + edges` | new script (likely `scripts/project-to-neo4j.mjs`) | idempotent, re-runnable, produces N persons matching v3 baseline ±5 % |
| 3.3 | Packet assembler | new `src/lib/packet.ts` | unit tests against the three golden packets |
| 3.4 | `GET /api/v1/person/:id/packet` | new `src/app/api/v1/person/[id]/packet/route.ts` | integration test → matches fixture; 401/404/200 paths covered |
| 3.5 | `POST /api/v1/person/:id/observation` | new `src/app/api/v1/person/[id]/observation/route.ts` + `observations` table migration | integration test: POST then GET, packet reflects within 30 s |

## Track 2.5 sub-tasks (running parallel with Track 3)

| # | Sub-task | Acceptance |
|---|---|---|
| 2.5.1 | New plugin scaffold at `packages/orbit-plugin/` | Registers three tools (`orbit_raw_events`, `orbit_person_packet`, `orbit_observation`) against the new API — nothing else |
| 2.5.2 | WhatsApp connector → `raw_events` | Live wacli events land in ledger within 500 ms; idempotent on replay |
| 2.5.3 | Gmail connector → `raw_events` | Same shape, same idempotency, same latency budget |
| 2.5.4 | Calendar, Slack, Linear | Shipped incrementally; each connector a separate commit + verification row |
| 2.5.5 | Plugin deployed to claw | Gateway running again; ingest lag < 5 min |

## Cross-cutting

From the master roadmap §Cross-cutting:

- **CC-3** `outputs/verification-log.md` — every non-trivial claim lands a row. [06-operating.md](./06-operating.md) carries the format.
- **CC-4** Vercel rollback rehearsal — still owed. Do after Track 3 deploy, not before.
- **CC-5** Nightly health cron on claw — after Track 5 is live (something worth monitoring).

## Open decisions

From [design spec §10](../docs/superpowers/specs/2026-04-18-orbit-v0-design.md):

- `contacts.other.readonly` scope (additive; 2–3× cross-source match rate when it lands) — deferred
- Constellation graph visualization — post-V0
- In-app AI chatbot — not day-1; OpenClaw agents are the interface
- Multi-tenant team agents — V2
- Mobile app — V2
