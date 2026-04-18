# Orbit V0 — Verification Log

Append-only ledger. Every build claim lands here with an evidence artifact and a rollback path.

---

## 2026-04-18 — Track 1, fix #1: Gmail connector availability on claw

**Claim:** "Gmail connector is disabled on claw and needs a PATH fix."

**Investigation:** SSH'd to claw, inspected live gateway state.

**Finding:** ❌ **CLAIM WAS WRONG.** The issue was stale state from a previous gateway run, not a PATH bug. After a gateway restart at 06:17:45 UTC on 2026-04-18:

```
[connector-registry] enabled: Google Calendar (batch)
[connector-registry] enabled: Gmail (batch)
[connector-registry] enabled: Linear (batch)
[connector-registry] skipped: Slack (not available)
[connector-registry] enabled: WhatsApp (realtime)
[plugins] [orbit] connectors enabled: calendar, gmail, linear, whatsapp
[connector-registry] batch poll scheduled: gmail every 2h
```

Direct reproduction on claw:

```
$ node -e "const {execFileSync} = require('child_process'); console.log(execFileSync('which', ['gws'], {encoding: 'utf8'}))"
/usr/bin/gws
```

**Resolution:** No code change needed. Moving to fix #2.

**Unexpected bonus finding:** plugin already has `identity cache: 11822 contacts, 860 LID mappings` on startup — some LID→phone bridging was already implemented by an earlier session.

---

## 2026-04-18 — Track 1, fix #2: preserve `source_event_id` / `thread_id` / `body_preview` / `direction` / `source` on INTERACTED edge

**Claim:** "Ingest pipeline drops ~40% of handoff-prescribed audit fields at `/api/v1/ingest`. Fix: add 5 nullable fields to the INTERACTED edge + the ingest payload schema."

**Change:**
- [src/lib/neo4j.ts](../src/lib/neo4j.ts): extended `InteractionBatchItem` interface with `source`, `sourceEventId`, `threadId`, `bodyPreview`, `direction` (all `string | null`). Cypher `CREATE (a)-[:INTERACTED {...}]->(b)` now writes all five fields.
- [src/app/api/v1/ingest/route.ts](../src/app/api/v1/ingest/route.ts): extended the interaction payload type with matching optional fields. `body_preview` truncated to 160 chars defensively. Null fallback for each.

**Safety:**
- Additive only — Neo4j is schemaless; old INTERACTED edges (without these fields) continue to read fine as null.
- Payload fields are optional — existing plugin sends without them, server writes nulls, no regression.
- No migration, no data rewrite, no breaking change.

**Evidence:**
```
$ npx tsc --noEmit
(exit 0, no output)
```

**Still pending (not part of this commit):**
- Plugin update to actually SEND `source_event_id` / `thread_id` / `body_preview` in the ingest payload. Without this, the new fields write nulls.
- Vercel deploy — until the new server code is live, plugin changes can't be tested end-to-end.
- Real-data verification: after both land, query a sample INTERACTED edge and confirm the new fields are populated.

**Rollback:** `git revert <commit-hash>` — safe at any time since the change is additive.

---

## 2026-04-18 — Track 1 scaffolding: Vitest + fixtures + four defensive fixes

**Claim:** "Track 1 of the V0 master roadmap is landed with code + regression tests for every sub-task."

**Changes:**
- Vitest wired (`package.json`, `vitest.config.ts`), CI workflow at `.github/workflows/test.yml`
- Regression test `tests/unit/interacted-edge-fields.test.ts` — locks in the 5 audit fields from fix #2 above so a future Cypher refactor cannot silently drop them
- Defensive resolver `packages/orbit-plugin/lib/gws-path.js` + tests `tests/unit/gmail-availability.test.js` — probes known absolute paths before falling back to `which`. Even though the live diagnosis (fix #1 entry above) showed the PATH fix was unnecessary on the current claw, the resolver is strictly additive and protects against the class of subprocess-PATH bugs elsewhere. Shared with `capabilities.js` so the capability report and connector availability never disagree.
- Deterministic fixture `tests/fixtures/wacli-minimal.db` (45 KB, 10 chats, 50 msgs, 5 contacts, 12 group_participants) built by `tests/fixtures/build-wacli-minimal.mjs`
- New importer `scripts/import-group-participants.mjs` + Cypher `src/lib/cypher/co-present-edge.cypher` — materializes WA group membership as `CO_PRESENT_IN` edges (weight 0.1, `source:'wa_group'`, accumulating `group_jids` array). Pure-over-`runCypher` so integration tests swap in a fake.
- LID→phone bridge scaffolding `scripts/lid-bridge-nightly.mjs` + seed `tests/fixtures/lid-seed.json` (35 synthetic pairs, confidence ≥ 0.8). Includes explicit anti-regression: single-token overlaps produce confidence < 1 never auto-merges (spec §5).

**Evidence:**

```
$ npm test
 RUN  v3.2.4

 ✓ tests/unit/sanity.test.js                    (1 test)
 ✓ tests/unit/interacted-edge-fields.test.ts    (5 tests)
 ✓ tests/unit/gmail-availability.test.js        (3 tests)
 ✓ tests/integration/group-participants-import.test.js (3 tests)
 ✓ tests/integration/lid-bridge.test.js         (3 tests)

 Test Files  5 passed (5)
      Tests  15 passed (15)
```

Full log: [outputs/verification/2026-04-18-track1/npm-test.log](./verification/2026-04-18-track1/npm-test.log)

**Deferred (requires infra access beyond worktree):**
- Live claw capability-report capture after a gateway restart — once landed, append `outputs/verification/2026-04-18-track1/gateway-channels-after-fix.txt`.
- Live dry-run of `scripts/import-group-participants.mjs` against Sanchay's real `wacli.db` — would emit `{groups_processed: N}` where N = count of WA groups with ≥ 2 known members. Run once the branch merges and the plugin can reach Neo4j.

**Rollback (each commit is independent):**
- `git revert` the commit of the specific sub-task
- All changes are additive — no schema drops, no data rewrite, no breaking contracts

**Commit:** _pending — to land as a single commit or per-task commits on `claude/cool-sammet-36b821`_

---
