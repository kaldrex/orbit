# Track 1 — Evidence Summary

**Date:** 2026-04-18
**Branch:** `claude/cool-sammet-36b821`
**Spec:** [docs/superpowers/specs/2026-04-18-orbit-v0-design.md](../../../docs/superpowers/specs/2026-04-18-orbit-v0-design.md)
**Plan:** [docs/superpowers/plans/2026-04-18-track-1-pipeline-fixes.md](../../../docs/superpowers/plans/2026-04-18-track-1-pipeline-fixes.md)

---

## Sub-task status

| # | Sub-task | Status | Evidence |
|---|---|---|---|
| 1.1 | INTERACTED audit-field preservation (commit `aa44a40`) | ✅ already merged | Regression test at `tests/unit/interacted-edge-fields.test.ts` (5 fields × 1 assertion each) |
| 1.2 | Gmail `gws` PATH hardening | ✅ defensive hardening committed | Resolver at `packages/orbit-plugin/lib/gws-path.js`; 3 unit tests. Live diagnosis in `outputs/verification-log.md` had already disproven the active-bug claim but the resolver still protects against the class of subprocess-PATH bugs |
| 1.3 | `group_participants` → `CO_PRESENT_IN` (weight 0.1) | ✅ code + integration tests | `scripts/import-group-participants.mjs`, `src/lib/cypher/co-present-edge.cypher`, 3 integration tests |
| 1.4 | LID→phone bridge nightly scaffolding | ✅ code + seed + tests | `scripts/lid-bridge-nightly.mjs`, `tests/fixtures/lid-seed.json` (35 pairs), 3 integration tests. Single-token auto-merge guard explicitly asserted |

## Test suite snapshot

```
 RUN  v3.2.4
 ✓ tests/unit/sanity.test.js                            (1 test)
 ✓ tests/unit/interacted-edge-fields.test.ts            (5 tests)
 ✓ tests/unit/gmail-availability.test.js                (3 tests)
 ✓ tests/integration/group-participants-import.test.js  (3 tests)
 ✓ tests/integration/lid-bridge.test.js                 (3 tests)

 Test Files  5 passed (5)
      Tests  15 passed (15)
```

Full log: [npm-test.log](./npm-test.log)

## Deferred to next deploy window

These require access beyond the worktree sandbox:

1. **Gateway capability-report capture** — after the next `systemctl --user restart openclaw-gateway.service` on `claw`, capture `channels=...` line to `gateway-channels-after-fix.txt`.
2. **Live group_participants dry-run** — run `WACLI_DB=~/.wacli/wacli.db node scripts/import-group-participants.mjs` against the real DB, write the JSON result to `group-participants-dryrun.json`.

These are logged as "deferred" in `outputs/verification-log.md` per testing spec §9 (no faked artifacts).

## Exit-gate check (per plan §Exit gate)

- [x] `npm test` exits 0 with ≥ 13 tests — **15 tests** actual
- [x] `outputs/verification-log.md` has a Track=1 row with a real `npm-test.log` path
- [ ] Commits landed on a branch with green CI — pending push + PR
- [x] Live-claw deferral explicitly recorded (no fake artifacts)

Once the commit lands and CI goes green, Track 1 flips to ✅ on the master roadmap.
