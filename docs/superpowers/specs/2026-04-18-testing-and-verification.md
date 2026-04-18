# Orbit V0 — Testing & Verification Strategy

**Date:** 2026-04-18
**Status:** Canonical testing contract — every claim against this system must be backed by evidence produced by procedures defined here.
**Companion to:** [2026-04-18-orbit-v0-design.md](./2026-04-18-orbit-v0-design.md)

---

## 0. Core principles

1. **No claim without evidence.** "It works" is never an accepted answer. Every claim cites an artifact: a test output, a committed file, a screenshot, a log line, a SQL count.
2. **Real data beats synthetic.** Sanchay's actual wacli.db (33,105 rows, 878 chats, ~30 hours of sync) + the hypothesis-test artifacts under `outputs/hypothesis-test-20260418{,-v2,-v3}/` are the baseline.
3. **Rollback over retry.** If a change breaks live plugin/server, the first move is revert, not patch.
4. **Progressive verification.** Each layer tested in isolation before integration; integration tested before e2e; e2e tested before declaring V0 done.
5. **Golden outputs as regression tests.** The three packets (`person_packet_imran.json`, `person_packet_hardeep.json`, `person_packet_aryan_yadav.json`) are the canonical regression fixtures. If a code change makes them drift, the change must justify the drift.

---

## 1. Three testing levels

### L1 — Unit (fast, local, no network)
- Pure functions
- Rule engine classification
- Schema validation
- Identity merge logic
- Going-cold math
- Observation validation
- Runtime: <5s per test; whole suite <60s

### L2 — Integration (fixtures + mocked externals)
- Plugin signal-buffer → mock `/api/v1/ingest`
- wacli.db importer against a fixture SQLite
- Gmail connector against mocked `gws` stdout
- Packet assembler against fixture raw_events
- Runtime: <5min whole suite

### L3 — End-to-end / real-world (live data, live infra)
- Ingest Sanchay's actual wacli.db → `raw_events` → packets
- Verify Imran/Aryan/Hardeep cards match golden JSONs
- Render in browser, screenshot
- Run against `claw` gateway, observe actual capability reports
- Post observation via API, verify next packet read reflects it
- Runtime: minutes-to-hours, manual or nightly cron

---

## 2. Per-component test contract

### 2.1 Rule engine (Orbit server)
| Test | Evidence |
|---|---|
| L1: table-driven 30+ cases covering each rule | `npm test rule-engine` passing output |
| L1: unicode names (Devanagari, Chinese, emoji) | Dedicated test file with ≥10 cases |
| L1: empty/null fields (no name, no domain) | Failure-mode tests with expected behavior |
| L2: classify the 162 active persons from v3 | JSON diff against curated golden set under `tests/golden/segments.json` |
| L3: live-classify against `claw` plugin output | Log snippet showing classified counts |

### 2.2 Identity resolver
| Test | Evidence |
|---|---|
| L1: deterministic merges (phone, email, JID) | Unit test output |
| L1: single-token collisions NEVER auto-merge | Dedicated anti-regression test (Jain/Yadav) |
| L1: fuzzy matches route to review queue | Unit test |
| L2: replicate the 2 canonical merges from v1 | `merge_candidates.csv` diff must match |
| L3: full run against Sanchay's data | Count of merges + sample list reviewed |

### 2.3 Packet assembler
| Test | Evidence |
|---|---|
| L1: assemble packet from fixture raw_events | Diff against `tests/golden/packet-fixture.json` |
| L2: assemble Imran's packet from subset of real data | Must match `outputs/hypothesis-test-20260418-v3/person_packet_imran.json` within tolerance |
| L2: assemble Aryan's packet, going-cold flag | Must show `going_cold: true`, `days_since_last: 18±1` |
| L3: render packet in UI, screenshot | Saved to `outputs/verification/packet-render-*.png` |

### 2.4 wacli.db direct importer
| Test | Evidence |
|---|---|
| L1: schema mapping wacli→raw_events | Unit test |
| L2: import `tests/fixtures/wacli-minimal.db` (10 chats, 50 msgs) | Row counts assertion |
| L3: import Sanchay's live wacli.db (rsync'd copy) | `SELECT COUNT(*)` before=33,105, after=33,105 (0 lossiness) |
| L3: idempotency — re-import same DB twice | Second import produces 0 new rows |

### 2.5 Gmail connector
| Test | Evidence |
|---|---|
| L1: header parsing + junk-filter rules | Unit tests with 20+ fixture headers |
| L2: mocked `gws` responses | Signal shape assertions |
| L3: live pull against Sanchay's Gmail (wide, 12mo) | Gateway log + row count in `raw_events` |
| L3: availability check under gateway subprocess | Capability report on `claw` shows `channels=whatsapp,gmail` (currently missing gmail — this is the Week-1 bug to fix) |

### 2.6 Going-cold detector
| Test | Evidence |
|---|---|
| L1: thresholds (14-60d, bidirectional, >10 msgs) | Unit test |
| L1: snooze override respected | Unit test |
| L2: run against real data, produce list | Must list Aryan Yadav in top 10 |
| L3: founder-facing UI shows going-cold list with named entries | Screenshot |

### 2.7 Observation API
| Test | Evidence |
|---|---|
| L1: schema validation per observation kind | Unit tests |
| L1: confidence bounds [0,1], evidence required | Unit tests |
| L2: POST observation, GET packet, verify field updated | Integration test with assertion |
| L3: live loop — OpenClaw posts, packet updates within 30s | API trace + packet diff |

### 2.8 UI (React components)
| Test | Evidence |
|---|---|
| L1: snapshot tests per card segment (peer/teammate/service/going-cold) | Jest snapshots |
| L2: render against fixture packets | Visual diff screenshots |
| L3: render Imran/Aryan/Hardeep from live data | Live screenshots committed to `outputs/verification/` |
| L3: responsive (mobile 375px, tablet 768px, desktop 1440px) | Three screenshots per card |

---

## 3. Real-world verification protocol — "running actual stuff, not speculation"

Every non-trivial claim produces artifacts in `outputs/verification/<date>-<slug>/`:

| Claim pattern | Required artifact |
|---|---|
| "Gmail connector ingesting" | `gateway-log-excerpt.txt` with `channels=whatsapp,gmail` + `gmail-row-count.sql.out` |
| "raw_events has N rows" | `raw-events-count.sql.out` with timestamp |
| "Imran's packet matches spec" | `packet-imran.json` + `diff-against-golden.txt` (empty = clean) |
| "Observation loop closes" | `api-trace.log` showing POST → GET sequence |
| "Going-cold list correct" | `going-cold-actual.csv` + diff against golden |
| "UI renders cards correctly" | Screenshots: `imran-card.png`, `aryan-card.png`, `hardeep-card.png` |
| "Deploy successful" | `vercel-deploy-url.txt` + `health-check.json` |

**Central log:** `outputs/verification-log.md` is an append-only ledger. Every claim gets a row:
```
2026-04-18 14:32  TRACK=1  CLAIM="Gmail connector path fix works on claw"
  evidence: outputs/verification/2026-04-18-gmail-path-fix/gateway-log-excerpt.txt
  method:   SSH to claw, tail journal for 5 min, grep "channels="
  result:   PASS — log shows channels=whatsapp,gmail,calendar (was whatsapp only before)
  commit:   abc1234
```

---

## 4. Fixtures (committed to repo)

Created under `tests/fixtures/`:

| File | Size | Contents |
|---|---|---|
| `wacli-minimal.db` | ~50KB | 10 chats (6 DM, 2 group, 2 unknown), 50 messages, 5 contacts with names |
| `wacli-sanchay-snapshot-20260418.db.gitignore` | 28MB | NOT committed; fetched via script from claw |
| `gmail-sample.jsonl` | ~200KB | 200 messages: 100 junk, 50 human, 50 edge-cases |
| `google-contacts-sample.json` | ~30KB | 50 contacts covering the 3-emails/0-both reality |
| `expected-packets/imran.json` | — | golden from hypothesis-test-v3 |
| `expected-packets/aryan.json` | — | golden going-cold case |
| `expected-packets/hardeep.json` | — | golden teammate with 21 shared groups |
| `expected-segments.json` | — | 162 persons → expected segment, for regression |

Fixtures must be reproducible — a script at `tests/fixtures/rebuild.sh` fetches live data, anonymizes PII, produces deterministic files.

---

## 5. CI — automated gates

**Per commit (GitHub Actions):**
- Lint + type-check
- L1 unit suite
- L2 integration suite
- Fixture freshness check (no stale-beyond-30-days fixtures)

**Pre-deploy to Vercel main:**
- All L1+L2 pass
- Schema migration dry-run (Supabase)
- Neo4j migration dry-run (if any)
- Golden packet regression diff = empty

**Nightly on claw (cron):**
- Plugin health check
- Gmail `+watch` streaming alive
- Ingest lag <5min
- Packet rebuild time <5min for 33k events
- Anomaly report to `outputs/verification/nightly-<date>.md`

---

## 6. Rollback

Per-track rollback plan:

**Track 1 (plugin pipeline fixes):**
- Keep prior plugin directory as `~/.openclaw/plugins/orbit-connector-prev/`
- Rollback: `mv plugins/orbit-connector plugins/orbit-connector-broken && mv plugins/orbit-connector-prev plugins/orbit-connector && systemctl --user restart openclaw-gateway.service`
- Verify: capability report resumes within 60s

**Track 2 (raw_events ledger):**
- All migrations are additive (new tables, never DROP)
- Rollback: stop writing to `raw_events`; system falls back to existing flow
- Verify: ingest rate unchanged in gateway logs

**Track 3 (projection + packet APIs):**
- New endpoints, parallel to existing
- Rollback: feature-flag off `/api/v1/person/:id/packet` (return 501)
- Verify: no UI failures (UI hasn't depended on packet API until Track 5)

**Track 4 (LLM enrichment):**
- Cron-driven job; rollback = disable cron entry
- Cached fields stay in place (no drop)

**Track 5 (UI):**
- Branch-deploy previews on Vercel
- Rollback = revert commit, redeploy (automatic)

**Track 6 (onboarding):**
- Feature-flag per-founder
- Rollback = flag off

**Vercel prod specifically:**
- Deploys are via git push to main
- Vercel auto-rollback: `vercel rollback <prev-deployment>` — must practice this once before depending on it
- Evidence: rollback rehearsal committed at `outputs/verification/2026-04-18-vercel-rollback-rehearsal.md`

---

## 7. Definition of "V0 ready" — the checklist

Before the system is claimed production-ready:

### Data layer
- [ ] `raw_events` has >30k rows from Sanchay's WA + >800 from wide Gmail + calendar + contacts
- [ ] Idempotent re-imports produce 0 new rows
- [ ] Neo4j projection rebuilds from raw_events in <5min
- [ ] Rule classification hits on 98% of active persons (matches v3 benchmark)

### API layer
- [ ] `POST /api/v1/raw_events` accepts plugin writes with idempotency
- [ ] `GET /api/v1/person/:id/packet` returns valid packet for top 50 persons
- [ ] `POST /api/v1/person/:id/observation` accepted + reflected within 30s
- [ ] Rate-limited, auth'd, tenant-isolated (multi-tenant `userId` check)

### Founder UI
- [ ] Today tab shows going-cold (8 named persons), this-week activity
- [ ] People tab lists 160 cards sorted by intensity, filterable by segment
- [ ] Person detail matches the Imran/Aryan/Hardeep layouts
- [ ] Needs Review tab shows ~9,800 bare-JID items for triage
- [ ] Search returns correct results for 5 test queries
- [ ] Dashboard first-paint <2s
- [ ] All 3 demo packets render cleanly with zero console errors

### Agent loop
- [ ] OpenClaw fetches packet via API for a real query
- [ ] OpenClaw posts observation back, next packet read shows it
- [ ] End-to-end: agent drafts reply using packet → user edits → observation written → next packet has new tone hint

### Ops
- [ ] Deploy runbook exists + was followed
- [ ] Rollback rehearsal completed (one forced failure, recovered)
- [ ] Nightly job monitors health, publishes report
- [ ] `outputs/verification-log.md` has entries for all above

---

## 8. What "verified" means for each upcoming commit

For every commit on the build track, the commit message includes:

```
<track>: <what changed>

Evidence:
  - outputs/verification/<date>/<artifact>.{png,json,log,sql}
  - test output: <npm/pytest command + pass/fail>
  - claim: <specific testable claim, e.g., "Imran packet identical to golden">

Rollback:
  - <one-line rollback command or git revert>
```

If a commit can't provide all three, it shouldn't land on main. It lands on a branch until evidence exists.

---

## 9. Escalation — when to pause and ask

I proceed autonomously for:
- Local code changes
- Commits + pushes to main (when CI passes)
- Additive migrations on Supabase
- Read-only operations anywhere
- Plugin changes on `claw` (with rollback path ready)

I pause and surface to Sanchay for:
- Destructive migrations (DROP, ALTER that rewrites data)
- Neo4j Aura schema changes that can't be rolled forward
- Any operation touching data that isn't recoverable from `raw_events`
- Production API breaking changes
- Cost-increasing ops (LLM spend beyond spec budgets)

---

## 10. The single question this doc must be able to answer

> "Did the thing we said would happen actually happen?"

For any claim: the answer is either **yes, here's the artifact** or **no, here's the failed run**. Nothing else is acceptable.
