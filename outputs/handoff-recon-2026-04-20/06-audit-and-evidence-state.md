# 06 · Audit & Evidence State — 2026-04-20

Read-only recon. Cross-references the 2026-04-20 audit (`outputs/audit-2026-04-20/report.md`) against the verification log (`outputs/verification-log.md`) and the cleanup narrative (`agent-docs/14-cleanup-2026-04-20.md`).

---

## 1. Audit findings table

Severity codes as in the report. Status is "fixed" when doc 14 records it as cleaned AND a verification-log row exists; "partial" when fixed but not independently logged; "deferred/tracked" when explicitly moved to memory as debt; "open" when still unresolved; "UNVERIFIED" when claimed fixed but has no log row.

### Code quality

| Finding | Sev | Status | Verification-log row |
|---|---|---|---|
| `resolveConfig()` throws breaking envelope contract (`index.js:70-71,99-100,118-119`) | critical | fixed | 2026-04-20 Stage 5c — names B1 explicitly; regression test cited |
| `merged_observation_ids:[id,id]` workaround, no TODO tag | high | deferred/tracked | Memory entry `project_tracked_debt_2026_04_20` (D5 approved). No log row — intentional non-fix. |
| `manifest-to-observations.mjs` hard-coded to v2 manifest | high | fixed | 2026-04-20 Stage 5c — B2 rebuilt to read v3 |
| Bulk transformer skips observer safety (phone/email-as-name) | high | fixed | 2026-04-20 Stage 5c — "Safety functions in new `orbit-rules-plugin/lib/safety.mjs` filtered 5,207 rows" |
| `manifest-gen.mjs:31` hard-coded self-email | medium | fixed | 2026-04-20 Stage 5c narrative doesn't mention it. Doc 14 B5 claims `ORBIT_SELF_EMAIL` cutover. **UNVERIFIED in log** — no dedicated row proving env-var migration. |
| `generate-merges.mjs` hard-coded USER_ID | medium | UNVERIFIED | Not mentioned in Stage 5c log row or doc 14 before/after table. Status unclear. |
| CLI schema mirror has no CI drift check | medium | open | No log row, no memory entry |
| 429 `Retry-After` docstring cites magic 60s | medium | open | No log row. Not in tracked debt. |
| `forwarded.mjs` wrap-match regex edge case | low | open | No log row. Noted as future concern only. |

### Data quality

| Finding | Sev | Status | Verification-log row |
|---|---|---|---|
| DB ingested from v2 manifest while viz reads v3 | critical | fixed | Stage 5c log row — re-ingest from v3 explicit |
| 99.97% persons are `category:"other"` placeholders | critical | fixed | Stage 6-v3 (1,568 enrichments) + Stage 6-v4 (1,470 re-enriched, −415 "other") |
| Umayr + Ramon duplicated | critical | fixed | Stage 5c — "0 duplicate Umayr/Ramon"; bridge-aware merger in `generate-merges-v2.mjs` |
| 5,028 phone-as-name rows (74%) | high | fixed | Stage 5c — "0 phone-as-name" in acceptance checks |
| 62 email-as-name + 109 Unicode-masked-phone + 5 quoted-literal | medium | fixed | Stage 5c — all counted to 0 |
| 30 LID-only humans silently skipped | medium | open | No log row. Doc 14 doesn't address. |
| `apitest.lead@example.com` test-data leak | medium | fixed | Stage 5c — "0 test-data leaks" |
| 74% of manifest rows have `name:null` (root cause) | medium | fixed | Doc 14 Phase A — `name.mjs` `pickBestName()` with `messages.sender_name` fallback. Stage 5c log row doesn't itemize this fallback. **Partial log coverage.** |

### Test coverage

| Finding | Sev | Status | Verification-log row |
|---|---|---|---|
| No tests for `manifest-to-observations.mjs`, `generate-merges.mjs`, `build-network-viz.mjs` | critical | partial | Stage 5c log says "Tests 196 → 329 green" but doesn't enumerate which scripts got coverage. Doc 14 claims "+~30 unit tests with real failing fixtures" in Phase A but the link between those tests and the three named scripts is not explicit. |
| `manifest-gen.mjs` (922 LOC) untested | high | UNVERIFIED | Not named in doc 14 or log. |
| No test for 429 non-retry policy | high | UNVERIFIED | Not claimed fixed anywhere. |
| No test for `resolveConfig()` envelope | high | fixed | Stage 5c B1 — "Regression test added" |
| Regression tests use synthetic, not real failures | medium | partial | Doc 14 says "real failing fixtures from the prior recon" — directional fix, not quantified. |

### Architectural discipline

| Finding | Sev | Status | Verification-log row |
|---|---|---|---|
| `generate-merges.mjs` opens direct `pg.Client` (breach of API-is-only-writer) | high | UNVERIFIED | Not called out in doc 14 or any log row. `generate-merges-v2.mjs` succeeded Stage 5c but the architectural-discipline angle (move to `scripts/`, SELECT-only comment) is silent. |

### Documentation fidelity

| Finding | Sev | Status | Verification-log row |
|---|---|---|---|
| CLAUDE.md routes/tables/test count stale | critical | fixed | 2026-04-20 Docs refresh — "CLAUDE.md test count 26 → 329. 3-contract framing → 5-contract" |
| `03-current-state.md` pre-observations | critical | fixed | 2026-04-20 Docs refresh — "6 stale-edited (03, ...)" |
| Handoff §3.3 pre-Stage-5 counts | high | fixed | Docs refresh row |
| README omits docs 12, 13 | high | fixed | Docs refresh — "1 index-updated (README.md)" |
| Doc 12 "173 tests green" stale | medium | fixed | Docs refresh (implicit) |
| Doc 12 describes system that's ~40% built (present tense) | medium | UNVERIFIED | Docs refresh doesn't itemize tense-correction |
| Doc 13 multi-tenant runbook can't run today | medium | partial | Some pieces (self-email env var) fixed; doc status-banner not confirmed |
| Verification log missing Stage 4 / 5 / 5b rows | low | fixed | Docs refresh — "Verification-log backfilled with Stage 6-v3 + 6-v4 + this row" (Stages 4, 5, 5b rows now present in the log, dated 2026-04-19) |

### Hidden debt (the 11-item table)

| Item | Audit status | Current status | Log/memory entry |
|---|---|---|---|
| `ORBIT_SELF_EMAIL` replacement | tracked | fixed | Memory (closed) |
| Unicode-masked-phone regex | invisible | fixed | Closed per doc 14 Phase A |
| `messages.sender_name` fallback | invisible | fixed | Closed per doc 14 Phase A |
| Group-junk heuristics | partial | fixed | `group-junk.mjs` shipped |
| Curation CLI verbs | partial | partial | `orbit_persons_list_enriched` shipped; block-email etc. open |
| CI / monitoring | invisible | deferred/tracked | Memory: `project_tracked_debt_2026_04_20` |
| API-key minting UI | tracked | open | Still tracked, no fix |
| OpenClaw `--verbose --json` observability | invisible | deferred/tracked | Memory entry |
| `[id, id]` merge workaround | partial | deferred/tracked | Memory entry (D5 approved) |
| Ramon/Umayr duplicate | invisible | fixed | Stage 5c row |
| v2→v3 re-ingest | invisible | fixed | Stage 5c row |

---

## 2. Verification-log health since 2026-04-18

The log has **14 entries** spanning 2026-04-18 through 2026-04-20. Chronology is clean; each row has Claim / Investigation / Evidence / Rollback in the stated template format.

**Strengths**
- Every Stage (4, 5, 5b, 5c, 6-v3, 6-v4) has a row. Stages 4/5/5b were backfilled during the 2026-04-20 docs refresh (the log itself flags this at line 193 of the audit and the refresh row confirms the backfill).
- Evidence pointers are concrete file paths, not prose. Multiple rows cite `diff` output, `psql` counts, and `curl` transcripts.
- Rollback paths are present on every recent row (even when "not required").
- Honest failure-capture: the 2026-04-18 "Gmail PATH fix" row is labelled "CLAIM WAS WRONG" rather than quietly deleted — this is the hallmark of a log that's actually being read and updated, not rubber-stamped.

**Gaps**
1. **Audit response itself has no dedicated row.** The audit ran 2026-04-20, produced 30-odd findings, and the fixes land in Stage 5c and Docs refresh rows — but there is no "2026-04-20 audit response" row that maps the 30 findings to the remediation work. You have to triangulate doc 14's before/after table against Stage 5c's 30 acceptance checks.
2. **Phase A (WhatsApp depth) has no dedicated log row.** Doc 14 claims "5 new rule modules, ~30 new tests" but the verification log never records Phase A independently. The 196→329 test jump is noted inside Stage 5c, not as its own evidence row.
3. **Direct-DB architectural breach** (`generate-merges.mjs` opening a `pg.Client`) is not addressed in the log at all, even though the audit called it a "high" architectural finding.
4. **Schema-mirror CI check, 429 retry test, Unicode-masked-phone corpus fixture** — three specific test additions the audit requested — have no log rows confirming they exist.

---

## 3. Open audit items

Still unresolved as of this recon:

- **CLI schema mirror drift check** — no CI test comparing `orbit-cli-plugin/lib/schema.mjs` against `src/lib/observations-schema.ts`.
- **429 `Retry-After` test** — behaviour correct in code, no regression test pinning it.
- **`forwarded.mjs` wrap-match edge case** — low severity, deferred.
- **30 LID-only humans silently skipped** — no follow-up; the `skipped.ndjson` cohort is still abandoned.
- **`manifest-gen.mjs` (922 LOC) golden test** — audit asked, nothing landed.
- **`generate-merges.mjs` direct `pg.Client`** — architectural breach never called out. v2 generator succeeded but the "move to `scripts/`, add SELECT-only comment" hardening didn't happen.
- **API-key minting UI** — blocks doc 13's multi-tenant runbook from being executable.
- **CI / monitoring** — tracked debt but no build.
- **OpenClaw `--verbose --json` observability** — tracked debt, no fix.
- **`merged_observation_ids.min(2)` schema quirk** — tracked debt, intentionally deferred.
- **Neo4j re-enablement** — tracked debt, intentionally deferred.

Net: of the ~30 original findings, roughly **20 are fixed, 6 are deferred-but-tracked, 4 remain open-and-untracked** (schema mirror CI, 429 test, LID-skipped humans, direct-DB breach).

---

## 4. Evidence-log honesty score

**Qualitative read: the log is still being used, but it has slipped half a step from "every claim gets a row" to "batched rows cover bundled claims".**

Evidence for "still genuinely used":
- The 2026-04-18 "Gmail PATH fix" row is literally titled "CLAIM WAS WRONG." A log being rubber-stamped never contains that sentence.
- Stage 5c lists 30 acceptance checks and explicitly names the rollback command (`pg_dump-pre-wipe.sql` restore).
- The fast-copy postscript on 2026-04-18 captures a reversal of engineering approach (HTTP bulk → direct COPY) with benchmark numbers and a stated lesson.
- Stage 6-v3 row reports a partial-failure-with-repost rather than pretending the first run succeeded cleanly.

Evidence for "slippage":
- The 2026-04-20 audit produced 30 findings. The response wasn't a 30-row dump — it was two rows (Stage 5c + Docs refresh) covering ~20 fixes apiece by bundling. That's efficient but it means the log no longer has 1:1 claim-to-evidence granularity for audit-driven work.
- Doc 14's before/after table is cleaner and more readable than the verification-log entries covering the same period. A reader answering "was X fixed?" is better off reading doc 14. That inverts the log's role.
- Phase A ("5 new rule modules, ~30 new tests") has no standalone row despite being a substantial code surface.
- Four audit items (schema-mirror CI, 429 test, direct-DB breach, LID-skipped humans) have no log row even though the audit called them out. These are silent omissions, not tracked deferrals.

**Score: B+.** The discipline is real. Failure-capture is honest. But bundling-by-phase has replaced per-claim granularity, and doc 14 is now doing work the log was designed to do. If the slippage continues, the log becomes a chronological index into docs, rather than the primary evidence surface.

---

## 5. Artifacts referenced

- `/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/outputs/audit-2026-04-20/report.md`
- `/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/outputs/audit-2026-04-20/summary.json`
- `/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/outputs/verification-log.md`
- `/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/agent-docs/14-cleanup-2026-04-20.md`
- `/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/outputs/cleanup-2026-04-20/` (pre-wipe dumps + post-reingest Umayr card)
