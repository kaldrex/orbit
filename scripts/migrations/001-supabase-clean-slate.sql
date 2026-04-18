-- 001-supabase-clean-slate.sql
-- 2026-04-18 — retire orphan tables + stale pointers left behind by the
-- clean-slate backend prune. See agent-docs/03-current-state.md changelog.
--
-- Dropped tables:
--   merge_audit   — 603 rows of history from the deleted /api/v1/merge route
--   connectors    — 0 rows, dead schema from deleted /api/connectors/* routes
--
-- Nulled fields:
--   profiles.self_node_id — pointed at a Neo4j Person node wiped this session
--
-- Kept as-is:
--   raw_events, api_keys, profiles (table), auth.users — still load-bearing
--
-- Idempotent. Safe to re-run.

BEGIN;

DROP TABLE IF EXISTS public.merge_audit CASCADE;
DROP TABLE IF EXISTS public.connectors CASCADE;

UPDATE public.profiles
   SET self_node_id = NULL
 WHERE self_node_id IS NOT NULL;

COMMIT;
