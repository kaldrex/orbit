# Audit 1 of 6 — Plan vs Reality (Phases 0–6)

**Audit date:** 2026-04-21
**Branch audited:** `v1-dashboard-and-vision-features` (14 V1 commits ahead of main, no push)
**Plan file:** `/Users/sanchay/.claude/plans/create-a-task-list-sparkling-fog.md`
**Worktree verification log:** `/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/outputs/verification-log.md` (804 lines, 2026-04-18 → 2026-04-21)
**Live dev server:** `localhost:3047` — running, `200` on `/`.
**Live test run (this session):** `npm test` → **36 files · 529 passed + 2 skipped · 13.4 s**.

> **Mechanical plan-discipline finding up top:** every phase header reads `[x DONE — <sha>]`, yet of 86 checkbox line-items only **9 are `[x]`** (all inside Phase 0 + P1.1–P1.3). Every `Verify PN` block is untouched. The plan file is not the source of truth for per-task completion; commit history + the worktree verification log are. Flagging once here; not counted against any phase's colour below because the plumbing is genuinely done.

---

## Per-phase table

| Phase | Header claim | Commit SHA | Files touched match plan? | Verification-log row? | Live probe | Verdict |
|---|---|---|---|---|---|---|
| **P0 — Foundation** | `[x] · 1b7745a` | `1b7745a` ✓ | Yes — `20260421_api_keys_table_and_rpc.sql`, `capability_reports.sql(+_fixes)`, `src/lib/neo4j.ts`, `/api/v1/keys`, `/api/v1/capabilities` all shipped | Yes (worktree log line 511) | `POST /api/v1/keys` → 401 (no creds, correct); `GET /api/v1/capabilities` → 401 (auth works, plan expected `{agents:[]}` under session which we didn't exercise this pass); tests 7+9+16 present | **GREEN** |
| **P1 — Wire + interactions** | `[x] · 301aa29` | `301aa29` ✓ | Yes — Dashboard rewired, PersonPanel rewired, AddContactDialog rewired, `scripts/build-interactions-from-raw-events.mjs` present, `select_person_card_rows` RPC migration present | Yes (line 548) | Umayr card live: name/company/title/category/emails/phones ALL match April-19 baseline. `last_touch=2026-04-16`. 11,755 interactions landed (plan expected ≥ 20k — **short**, flagged as AMBER sub-point) | **AMBER** |
| **P2 — Constellation graph** | `[x] · 5a27faf` | `5a27faf` ✓ | Yes — `/api/v1/graph/populate`, `/api/v1/graph`, `neo4j-writes.ts`, `graph-transforms.ts` CATEGORY_META trimmed to 9 cats | Yes (line 594) | `GET /api/v1/graph` → 200 · **1,602 nodes · 1,232 links** (plan target was "> 2,000"; P5 LID-bridge subwork pushed edges 160 → 1,232, still under 2k). Idempotent re-run documented | **AMBER** |
| **P3 — Intro path + intel** | `[x] · 10d2bc7` | `10d2bc7` ✓ | Yes — `/path`, `/communities`, `/centrality` routes, IntroPathSearch + PathStrip + CommunityToggle UI, `graph-intelligence.ts` | Yes (line 636) | `/path/<me>/<umayr>` → 200 · 1 hop EMAILED · affinity 0.734. `/communities` + `/centrality` → **501 `GDS_MISSING`** (Aura Graph Analytics not on paid tier — plan Verify asked for ≥ 5 communities + top-10 hubs; feature is code-complete but **gated by billing**) | **AMBER** |
| **P4 — Vision trio** | `[x] · ba8d7c2` | `ba8d7c2` ✓ | Yes — `/persons/going-cold`, `/meetings/upcoming`, `/person/:id/topics`, `meetings`+`person_topics` migrations, MeetingsStrip UI, topic chips, `scripts/topic-resonance.mjs`, 2 claw SKILLs | Partial — only **P4-C topic-resonance** has a dedicated row (line 674). **No P4-A (going-cold) or P4-B (meetings) entry** in worktree log. P5 entry (line 762) covers adjacent work | `/persons/going-cold` → 200 · **42 persons** (plan expected ≥ 1). `/meetings/upcoming` → 200 · **5 meetings** incl. Hardeep briefs (one stale "Audit Probe Meeting" from a prior session). Umayr topics: 10 topics matching log | **AMBER** |
| **P4.5 — CLI rebalance** | no header DONE marker in plan (added post-hoc) | `0e61f12` ✓ | Yes — orbit-cli 0.1 → 0.3, 11 new verbs, SKILLs thinned, +33 CLI tests | **No verification-log row** for the rebalance itself | orbit-cli-plugin v0.3.0 confirmed via `openclaw.plugin.json`; tests green | **AMBER** |
| **P5 — Living Orbit** | no `[x DONE]` header | `75ed8f4` + fixup `03c9c61` ✓ | Yes — `jobs` table + pg_cron migrations, `/api/v1/jobs/{claim,report}`, `enricher-v5-haiku.mjs`, `orbit-job-runner` SKILL with systemd unit + 4 dispatchers, LID-bridge sub-workstream | Yes (line 762, P5 main) + LID bridge (line 729). **Sub-blocks P5.1–P5.4 not itemised** in plan but covered narratively | `POST /api/v1/jobs/claim` → 401 (auth gate works). pg_cron schedules live (`orbit-observer-tick`, `orbit-meeting-sync-tick`, `orbit-enricher-tick`). Enricher-v5 has **never run against live data** (per log: cost = $0, "first run on next 1st/15th"). Fixup commit confirms orphan jobs required manual release — plan didn't anticipate orphan reaper | **AMBER** |
| **P6 — Checkpoint + user-2** | no marker; all items `[ ]` | — | — | — | Working tree clean. `git push` **not executed** (correct — P6.4 is the explicit human gate, awaiting Sanchay's "push it"). No PR opened. No second-founder onboarded | **RED (pending by design)** |

### Sub-workstreams inside P5 (plan references P5.1–P5.4 only in this audit prompt, not in the plan file itself)

| Sub | What the commit covers | Verdict |
|---|---|---|
| P5.1 — LID↔phone bridge | `20260421_lid_phone_bridge.sql` + route + populate-script + bridge-aware graph populate. Edges 160 → 1,232 | GREEN |
| P5.2 — Haiku enricher | `scripts/enricher-v5-haiku.mjs` written + ResilientWorker-wrapped + unit tests. **Not executed live** | AMBER |
| P5.3 — Jobs queue routes | `jobs` table + 3 RPCs + `/jobs/claim` + `/jobs/report` + pg_cron. SQL + HTTP round-trip verified | GREEN |
| P5.4 — Claw cron runner | `orbit-job-runner.service`/`.timer` + 4 dispatchers + `run-once.sh`. Fixup required: `User=sanchay` removed, `TimeoutStartSec` 300 → 1500, dispatchers switched from `openclaw run` to `openclaw agent`. Service currently live on claw, but plan's Verify P5 bullet ("new WA msg → card updated < 16 min") **not demonstrated end-to-end** in the log | AMBER |

---

## Green / Amber / Red counts

**Phases (0 → 6, treating P4.5 as a separate pass): 8 rows**
- **GREEN: 1** (P0)
- **AMBER: 6** (P1, P2, P3, P4, P4.5, P5)
- **RED: 1** (P6 — pending by design, not a failure)

**Overall phase completion:** ≈ **80 %** — every phase that was meant to ship code has the code committed, the routes return real data against live infra, and the tests pass (529/531). The residue is a handful of plan-stated numeric targets the live state falls short of, plus documentation debt in the plan file itself.

---

## AMBER / RED items (fix suggestions, one line each)

1. **P1 — interaction count short of plan:** 11,755 landed vs plan target ≥ 20,000. Fix: re-run `scripts/build-interactions-from-raw-events.mjs` with `--resume` once; most gap is probably unresolved senders that LID-bridge now covers. (P5.1 landed after P1's pipeline run.)
2. **P2 — edge count short of plan:** 1,232 vs "> 2,000". Fix: the plan target predated the LID-bridge discovery; either re-baseline the plan number OR add `REACTIONS_TO`/co-appearance edges per `agent-docs/18-neo4j-edge-model-proposal.md`.
3. **P3 — Leiden communities + betweenness gated by Aura Graph Analytics tier:** both routes ship 501 `GDS_MISSING`. Fix: either enable the paid GDS tier (Sanchay decision), OR port to pure-Cypher approximations (label propagation for communities, degree-proxy for centrality).
4. **P4 — missing verification-log rows for Going Cold (P4-A) and Meeting Briefs (P4-B):** only topic-resonance (P4-C) was logged. Fix: append two retrospective rows with existing artefacts (curl transcripts + migration hashes).
5. **P4 — stale "Audit Probe Meeting" leaking into `/meetings/upcoming`:** dummy row `meeting_id=audit-1776749803720` still visible. Fix: `DELETE FROM meetings WHERE meeting_id LIKE 'audit-%';` (or add an `is_test` filter).
6. **P4.5 — no verification-log row for the CLI rebalance:** commit `0e61f12` ships 11 verbs + 33 tests but is invisible in the ledger. Fix: one-row back-fill.
7. **P5 — enricher-v5 never executed live:** script + tests exist, no observations written, cost = $0 so far. Fix: one manual `node scripts/enricher-v5-haiku.mjs --limit 10 --dry-run=false` to prove the path end-to-end before handing to the systemd timer.
8. **P5 — end-to-end heartbeat ("WA msg → card update < 16 min") unverified:** the fixup commit (`03c9c61`) says the claw handler was still running at commit time. Fix: send a test WA msg, wait one tick, confirm new `kind:"interaction"` observation and updated `last_touch`; append a verification-log row with timestamps.
9. **P5 — orphan-job reaper missing:** fixup commit explicitly flagged 2 orphans needed manual SQL cleanup. Fix: add a pg_cron tick that sets `completed_at + status='failed'` for rows where `claimed_at < NOW() - INTERVAL '30 min'`.
10. **Plan-file hygiene:** 77 of 86 checkboxes still `[ ]` despite DONE headers and green verifications. Fix: single pass to flip `[ ]` → `[x]` where evidence exists, and `[!]` + note where blocked (e.g. P3 communities/centrality → `[!] GDS tier not enabled`).
11. **P6 — pending by design:** not a defect. Will remain RED until Sanchay issues "push it" at the P6.4 human gate.

---

## Appendix — commands used

```
git log v1-dashboard-and-vision-features --oneline main..HEAD
git show --stat <sha>        # for each of 1b7745a, 301aa29, 5a27faf, 10d2bc7, ba8d7c2, 0e61f12, 75ed8f4, 03c9c61
curl -H "Authorization: Bearer $ORBIT_API_KEY" http://localhost:3047/api/v1/{graph,persons/going-cold,meetings/upcoming,person/67050b91-.../card,person/67050b91-.../topics,graph/path/994a9f96-.../67050b91-...,graph/communities,graph/centrality}
npm test
cat outputs/verification-log.md | grep '^## '
ls supabase/migrations/ | grep 20260421
```
