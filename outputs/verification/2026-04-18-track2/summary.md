# Track 2 — Evidence Summary

**Date:** 2026-04-18
**Branch:** `claude/cool-sammet-36b821`
**Spec:** [docs/superpowers/specs/2026-04-18-orbit-v0-design.md](../../../docs/superpowers/specs/2026-04-18-orbit-v0-design.md)
**Plan:** [docs/superpowers/plans/2026-04-18-track-2-raw-events-ledger.md](../../../docs/superpowers/plans/2026-04-18-track-2-raw-events-ledger.md)

---

## Sub-task status

| # | Sub-task | Status | Evidence |
|---|---|---|---|
| 2.1 | `raw_events` Supabase migration + indexes + RLS | ✅ committed | [supabase/migrations/20260418_raw_events.sql](../../../supabase/migrations/20260418_raw_events.sql) |
| 2.2 | `upsert_raw_events` RPC (SECURITY DEFINER) | ✅ committed | [supabase/migrations/20260418_upsert_raw_events_rpc.sql](../../../supabase/migrations/20260418_upsert_raw_events_rpc.sql) |
| 2.3 | zod schema + 8 unit tests | ✅ passing | `tests/unit/raw-events-schema.test.ts` |
| 2.4 | `POST /api/v1/raw_events` + 5 integration tests | ✅ passing | `tests/integration/raw-events-endpoint.test.ts` |
| 2.5 | wacli bulk importer + 4 integration tests | ✅ passing | `tests/integration/wacli-to-raw-events.test.js` |
| 2.6 | JSONL bootstrap importer + 1 integration test | ✅ passing | `tests/integration/jsonl-to-raw-events.test.js` |

## Test suite snapshot

```
 Test Files  9 passed (9)
      Tests  33 passed (33)
```

Full log: [npm-test.log](./npm-test.log)

Type check: `npx tsc --noEmit` — clean.

## Deferred to deploy window

These require infra access beyond the worktree:

1. **Apply migrations to production Supabase** — `supabase db push` with `$SUPABASE_DB_URL`. Both migrations are additive, no DROP, no data rewrite.
2. **Live bulk import of Sanchay's 33 k wacli messages** — `WACLI_DB=~/.wacli/wacli.db ORBIT_API_KEY=... node scripts/import-wacli-to-raw-events.mjs` after the migrations are live. Expected artifact: `outputs/verification/2026-04-18-track2/wacli-import-counts.log` with `inserted`/`updated` totals.
3. **Idempotency spot-check** — run the wacli import twice; second run should report `updated = count(rows)` and `inserted = 0`.

## Key contracts to protect in Track 3+

- Unique constraint `(user_id, source, source_event_id)` is the idempotency key. Track 3 projection jobs must not assume `id` is stable across re-imports — key on the triple instead.
- `participants_raw` is untyped `jsonb` on purpose — lets connectors evolve without migrations. Downstream projection normalizes into `interactions`.
- `raw_ref` is where the full payload lives (or a storage pointer to it). Track 3 can opt to fetch it lazily.

## Exit-gate check (per plan §Exit gate)

- [x] `npm test` exits 0 with all tests green — 33/33
- [ ] Migrations applied to production Supabase — deferred (documented above)
- [x] wacli importer passes fixture-based tests
- [x] `outputs/verification-log.md` has a Track=2 row

Once the migrations are applied in prod and the live wacli import captures its counts, Track 2 flips to ✅ on the master roadmap.
