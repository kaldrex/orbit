# Audit 6/6 — Tests, Debt, Documentation Drift (2026-04-21)

**Scope:** cross-reference test surface, debt ledger, documentation drift, verification-log completeness, and uncommitted state.
**Method:** `npm test` run live, `git status --short`, `git log v1-dashboard-and-vision-features ^main`, file greps, memory entries cross-referenced.
**Disposition:** audit-only — nothing modified, nothing committed.

---

## 1. Test coverage table

**Live run: 36 files, 529 passed, 2 skipped, 0 failed.** Duration ~15s.

| Domain | Unit | Integration | Files | Tests | Notes |
|---|---|---|---|---|---|
| raw_events / ingress | 1 (`upsert-raw-events-rpc`) | 2 (`raw-events-endpoint`, `wacli-to-raw-events`) | 3 | ~15 | healthy |
| observations basket | 1 (`observations-schema`) | 1 (`observations-endpoint`) | 2 | ~30 | healthy |
| card assembler | 1 (`card-assembler`) | 1 (`person-card-endpoint`) | 2 | ~15 | healthy |
| correction | 0 | 1 (`person-correct-endpoint`) | 1 | 6 | unit coverage would help |
| enriched persons | 0 | 1 (`persons-enriched-endpoint`) | 1 | 10 (+1 skip) | `describe.skipIf(!LIVE)` — live-db block intentionally gated |
| graph (populate + intel) | 2 (`graph-transforms`, `graph-intelligence`) | 2 (`graph-populate-route`, `graph-intel-routes`) | 4 | ~60 | 1 `.skip` (`GDS_MISSING — no longer applicable`) — stale test kept as placeholder |
| meetings | 1 (`meetings-strip`) | 1 (`v1-meetings-upcoming`) | 2 | 13 | healthy |
| topics / resonance | 1 (`topic-chip`) | 1 (`v1-person-topics`) | 2 | 10 | healthy |
| going-cold | 0 | 1 (`v1-persons-going-cold`) | 1 | 5 | no unit layer |
| jobs / cron | 0 | 1 (`v1-jobs`) | 1 | 15 | no unit layer for enqueue/claim logic |
| keys (API auth) | 0 | 1 (`v1-keys`) | 1 | 7 | no unit layer |
| capabilities | 0 | 1 (`v1-capabilities`) | 1 | 9 | healthy |
| self-init | 0 | 1 (`v1-self-init`) | 1 | ? | integration-only |
| neo4j client | 1 (`neo4j-client`) | 0 | 1 | 16 | retry/singleton covered |
| CLI plugin | 3 (`orbit-cli-new-verbs`, `orbit-cli-plugin`, `resilient-worker`) | 0 | 3 | ~100 | strong coverage |
| rules plugin | 4 (`orbit-rules-plugin` + name/safety/group-junk) | 0 | 4 | ~80 | strong coverage |
| merge / manifest | 2 (`generate-merges-v2`, `manifest-to-observations`) | 1 (`manifest-gen-enrichment-loop`) | 3 | ~30 | healthy |
| misc schema / sanity | 2 (`raw-events-schema`, `sanity`) | 0 | 2 | ~10 | — |
| graph endpoints extra | 0 | 1 (`graph-endpoints`) | 1 | ? | — |

**Skipped tests (2):**
1. `graph-intel-routes.test.ts:182` — `it.skip("GDS_MISSING — no longer applicable to /path (pure Cypher)")` — safe to delete; rewrite in pure Cypher already shipped.
2. `persons-enriched-endpoint.test.ts:212` — `describe.skipIf(!LIVE)` — gated live-DB smoke test; intentional.

**Zero-coverage / under-covered domains:**
- **LID bridge**: integration-level coverage sits inside `graph-populate-route.test.ts`; no dedicated `lid-bridge` test file. The recently-shipped `scripts/populate-lid-bridge.mjs` has no unit test.
- **`scripts/enricher-v5-haiku.mjs`**: shipped in Phase 5, no unit test (noted in log). `scripts/enricher-v3.mjs` / `v4.mjs` also untested.
- **`scripts/topic-resonance.mjs` / `repost-topics.mjs`**: no unit test.
- **pg_cron scheduling**: zero test — only the claim/report route is tested, not the schedule→enqueue path.
- **`src/lib/scoring.ts`**: no dedicated test file visible.
- **`src/lib/meetings-format.ts`**: no dedicated test file visible (only strip pure helper tested).
- **Claw-side SKILLs + `orbit-job-runner/` shell dispatchers**: no tests at all (bash-only, runtime-tested via live runs).

---

## 2. Debt ledger table

**Known-debt sources reconciled:** memory (`project_tracked_debt_2026_04_20.md`), in-code TODO/FIXME/HACK (only 1 match across src/scripts/plugins), verification-log "Flagged for Sanchay" items (found in rows for Phase 3 intel + Phase 4-C topics), prior audit `outputs/audit-2026-04-20/summary.json`.

| # | Item | Status | Owner / Source | Unblocks |
|---|---|---|---|---|
| D1 | CI / monitoring not wired | OPEN | memory `project_tracked_debt` §1 | Multi-founder onboarding, public deploy |
| D2 | `openclaw agent --verbose --json` doesn't expose tool_use blocks | OPEN (external) | memory §2; Stage 4 smoke | Audit trail visibility on agent runs |
| D3 | `merged_observation_ids.min(2)` schema quirk (`[id, id]` duplicate trick) | OPEN | memory §3; `scripts/generate-merges-v2.mjs:130` inline `TODO(schema-min2)` (the ONE code TODO in the repo) | Per-channel observer architecture; cleaner merge emission; `AddContactDialog` fix (log §586 flags it) |
| D4 | Neo4j re-enablement at scale | OPEN (deferred indefinitely) | memory §4 | Community detection (Leiden), >50k-person graph traversal |
| D5 | Aura Graph Analytics tier (Leiden + betweenness disabled) | OPEN | log §666 Phase-3 flagged | Community coloring, top-hub size-bumps |
| D6 | `user.selfNodeId` is NULL today | OPEN | log §667 Phase-3 flagged | End-to-end intro-path wiring for Sanchay |
| D7 | Intro-path uses unweighted `shortestPath()` (picks hops, not affinity) | OPEN | log §668 Phase-3 flagged | Weighted intro paths post-GDS |
| D8 | Prompt cache not firing on Haiku 4.5 (topic-resonance: $1.72 vs ~$0.20) | OPEN | log §720 Phase-4-C flagged | ~10x cost reduction on batched LLM passes |
| D9 | Mac dev server is SPOF for long claw-side runs | OPEN | log §721 Phase-4-C flagged | Reliable long-running enrichment from claw |
| D10 | `~/orbit-pipeline-tmp/package.json` carries its own deps on claw | OPEN | log §723 Phase-4-C flagged | Real `npm install` on claw against orbit checkout |
| D11 | Enricher-v5 never run against live data | OPEN | log §800 Phase-5 evidence | First real scheduled enrichment (waits for 1st/15th cron tick OR manual kick) |
| D12 | UI still fetches routes that 404 (`/api/graph`, `/api/init`, etc.) | PARTIAL (v1 routes added; old client paths?) | doc 03 §66 | Clean dashboard on V1 routes |
| C1 | Unicode-masked-phone regex | CLOSED | memory closed list |  |
| C2 | `messages.sender_name` fallback | CLOSED | memory closed list |  |
| C3 | v2/v3 manifest divergence | CLOSED | memory closed list |  |
| C4 | Umayr / Ramon duplicate person_ids | CLOSED | memory closed list |  |
| C5 | `ORBIT_SELF_EMAIL` hardcode | CLOSED | memory closed list |  |
| C6 | `resolveConfig` uncaught throw | CLOSED | memory closed list |  |

**Summary: 11 OPEN · 1 PARTIAL · 6 CLOSED.**

**Top 3 open items (by blast radius × proximity):**
1. **D3 — `merged_observation_ids.min(2)`** — still the only code-level TODO in the repo; `AddContactDialog` depends on it, log §586 already flagged it. The cleanest win post-V1.
2. **D11 — enricher-v5 has never run against live data.** Shipped + tested in isolation, but next-tick trigger is mid-May. Without a manual kick there's no proof the scheduled loop closes.
3. **D8 — prompt cache silent no-op on Haiku 4.5.** Real money on the table the moment the enricher loop runs continuously. Should be investigated before D11 triggers.

---

## 3. Documentation drift

### 3a. `agent-docs/03-current-state.md`

| Claim in doc | Reality | Verdict |
|---|---|---|
| "5 live API routes" (doc §9, §19) | `src/app/api/v1/` now has **11 route families**: raw_events, observations, person/[id]/{card,correct,topics}, persons/{enriched,going-cold}, meetings/upcoming, capabilities, graph/{populate,path,communities,centrality,neighbors,route}, jobs/{claim,report}, keys, lid_bridge/upsert, self/init | **STALE** |
| "329 tests green across 19 files" | `npm test` → **529 passing / 36 files** | **STALE** |
| "Rule layer: 10 modules" | Still accurate per `orbit-rules-plugin/lib/` | OK |
| "CLI plugin: 4 verbs" | Log §0e61f12 says v0.2.0 has 11 new verbs + 15 total; v0.3.0 adds `orbit_lid_bridge_upsert` | **STALE** |
| "Supabase `observations` ~4,700 rows" | Prior audit counted 13,626; post-V1 writes not re-checked — counts almost certainly shifted | **STALE** (counts not refreshed) |
| "Neo4j: Empty today" | Still empty per the audit chain, but prompt in user request implies 1,232 edges expected — that number is Postgres-projection-land (graph populate route), not Neo4j. Doc is structurally accurate; user's stated "edges=1232" maps to `lid_phone_bridge`-resolved SHARED_GROUP count | OK-ish (ambiguous wording) |
| "`persons` 1,602 rows" | Matches the prompt's `persons=1602`; not re-queried | Likely OK |

### 3b. `CLAUDE.md` (project file)

| Claim | Reality | Verdict |
|---|---|---|
| "5 live routes" | 11 route families | **STALE** |
| "329 passing across 19 test files" | 529 / 36 | **STALE** |
| "orbit-cli-plugin: 4 verbs" | 15+ verbs (v0.3.0) | **STALE** |
| "Tests: ~1.2s" | ~15s now | STALE (minor) |
| Non-negotiable rules 1-7 | Still accurate | OK |

### 3c. `agent-docs/README.md` index

Every referenced doc (04 archive, 05 archive, 01, 02, 03, 06, 09, 10, 11, 12, 13, 14, 15, 16, 17, 18) **exists on disk.** Index is complete; no broken links.

**But:** README.md still says "329 tests green" + "1602 persons" in its "Start here" §2. Same stale count.

### 3d. Summary

- **3 docs with stale counts:** `CLAUDE.md`, `agent-docs/03-current-state.md`, `agent-docs/README.md`.
- **New doc 18** (`18-neo4j-edge-model-proposal.md`) exists on disk but **not indexed in README.md's "When to read what" table**.
- **Archive note OK:** `archive/04-roadmap.md` + `archive/05-golden-packets.md` correctly banner-marked.

---

## 4. Verification-log integrity

**V1 commits** (`git log v1-dashboard-and-vision-features ^main`): **25 commits.**

Cross-reference to verification-log rows (headers grepped):

| Commit | Log row? |
|---|---|
| `caed49a docs(openclaw-snapshot)` | N/A (recon, not build) |
| `ef67053 feat(v0-orbit): observations basket` | YES (2026-04-19 pre-rows exist) |
| `0c36ad1 feat(v0-orbit): card assembler` | YES |
| `2da5414 feat(orbit-rules)` | YES (Stage 4) |
| `49d534f feat(v0-orbit): observer+resolver SKILLs` | YES |
| `bd5ea54 verify(v0-orbit): Umayr card` | YES ("V0 observer/resolver live run — Umayr") |
| `a61843f feat(v0-orbit): auto-merge` | implied in Stage 5/5b |
| `0fcb0f6 verify(v0-orbit): Ramon card` | YES |
| `bedd1d8 fix(card-assembler): jaccard-dedupe` | **NO direct row** (rolled into card-assembler work) |
| `a351f69 docs(agent-docs): 11-v0-pipeline-handoff` | N/A (docs) |
| `6c9b753 checkpoint(2026-04-20): full session` | YES (Stage 5c/6-v3/6-v4/Docs rows) |
| `36dd6df chore(v1-scaffold): session carry-over — N+1 fix` | YES (2026-04-20 /persons/enriched N+1 fix) |
| `1b7745a feat(v1-foundation): api_keys + neo4j client + capabilities + keys` | YES (Phase 0 foundation) |
| `301aa29 feat(v1-wire): dashboard + interaction + card-row RPC` | YES (Phase 1 wire) |
| `5a27faf feat(v1-graph): populate + constellation` | YES (Phase 2 constellation) |
| `10d2bc7 feat(v1-intel): intro path + communities + centrality` | YES (Phase 3 intel) |
| `ba8d7c2 feat(v1-vision): going-cold + meeting-briefs + topic-resonance` | PARTIAL — Topic-Resonance has a row (Phase 4-C). **No standalone row for "going-cold" or "meeting-briefs"** — they're bundled under "all landing-page promises live." |
| `0e61f12 refactor(v1-rebalance): orbit-cli v0.2.0 — 11 new verbs, thinned SKILLs` | **NO ROW** — large refactor (new verbs + SKILL trimming) has no verification log entry. |
| `a45b9da fix(v1-dashboard): dim-not-remove filter + cap + no re-zoom` | **NO ROW** (UI fix) |
| `f16e5fd perf(v1-dashboard): cap render pool at 300 nodes` | **NO ROW** (UI perf) |
| `9f7a3cf fix(v1-dashboard): default radial layout` | **NO ROW** (UI fix) |
| `399b8df fix(v1-dashboard): render only connected + 4× faster PersonPanel` | **NO ROW** (UI fix) |
| `71b79e5 fix(v1-dashboard): restore force-directed + animation` | **NO ROW** (UI fix) |
| `75ed8f4 feat(v1-living): Phase 5 — jobs + cron + Haiku + LID bridge` | YES (two rows: LID bridge + Phase 5) |
| `03c9c61 fix(v1-living): claw job runner — systemd + dispatcher` | **NO ROW** (subsequent fix; Phase 5 row was written earlier) |

**Coverage math:**
- 25 commits total
- 3 are docs / N/A
- 22 build commits
- 14 have a direct or bundled row
- **8 have no row** (the 5 UI dashboard fixes + orbit-cli v0.2.0 refactor + going-cold standalone + meeting-briefs standalone + claw-runner fix)

**Completeness:** 14/22 = **~64%.** UI dashboard fixes are the biggest gap. The cli v0.2.0 refactor (0e61f12) is the most-concerning missing row given blast radius.

---

## 5. Uncommitted-file audit

`git status --short` output: **EMPTY.** No untracked files, no modified files, no staged-but-uncommitted work. All subagent work was committed. Clean.

---

## 6. Cross-cut issues

### 6a. Memory entries referencing removed / renamed paths

Spot-checked `project_tracked_debt_2026_04_20.md`: references `outputs/research-2026-04-20/oss-algorithms.md`, `agent-docs/14-cleanup-2026-04-20.md`, `orbit-rules-plugin/lib/safety.mjs`, `orbit-rules-plugin/lib/name.mjs`, `src/lib/observations-schema.ts`, `orbit-cli-plugin/lib/schema.mjs`, `outputs/stage-5b-merges-2026-04-19/generate-merges.mjs`. **All paths exist on disk.** No stale pointers.

### 6b. Imports referencing missing files

No build run (would take minutes + pollute .next). Proxy check: TODO scan across `src/`, `orbit-cli-plugin/`, `orbit-rules-plugin/` returned **1 match total** (`scripts/generate-merges-v2.mjs:130`). That's extraordinarily low noise and implies clean import hygiene. Doc 03 §66 acknowledges some UI client components still fetch routes that may have been restored under V1; worth a live-404 sweep but out of scope for audit-only.

### 6c. Doc 03 vs current lib dir

Doc 03 lists lib files as keepers (`raw-events-schema`, `observations-schema`, `card-assembler`, `api-auth`, `auth`, `supabase/*`, `categories`, `scoring`, `graph-transforms`, `reagraph-theme`, `utils`) — **11 entries.** Actual `src/lib/` has **17 files** including post-doc-03 additions: `graph-intelligence.ts`, `meetings-format.ts`, `neo4j-gds.ts`, `neo4j-writes.ts`, `neo4j.ts` (deleted per prune claim, re-added per Phase 0), `topic-chip.ts`. Doc 03 is missing 6 lib files.

### 6d. Migrations count

Doc 03 does not list a migration count explicitly. Actual: **26 migrations** (1 existed pre-prune, 19 added 2026-04-17 → 2026-04-22). `CLAUDE.md` non-neg rule §1 says "every non-trivial build claim lands a row in verification-log" — the migrations are listed inline in relevant rows, which is correct.

---

## Bottom line

- Tests healthy (529/36, 2 intentional skips). Gaps sit on shell dispatchers, claw SKILLs, and some scripts.
- 11 open debt items, 3 most-important: D3 min(2) schema quirk, D11 enricher-v5 never-run, D8 prompt cache.
- 3 docs out of date (CLAUDE.md, agent-docs/03-current-state.md, agent-docs/README.md) — all share the same stale counts ("329 tests / 19 files / 5 routes / 4 verbs").
- Verification-log at ~64% coverage of V1 commits. UI dashboard fixes + cli v0.2.0 refactor are the gaps.
- Working tree is clean.
- Memory entries audit clean — no stale path pointers.
