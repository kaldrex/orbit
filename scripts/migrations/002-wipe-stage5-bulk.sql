-- Migration 002 — wipe Stage 5 (bulk ingest) + Stage 5b (bulk merges).
-- Scoped to Sanchay's user_id. Safe on Supabase test project.
--
-- Drops:
--   - All observations with evidence_pointer LIKE 'manifest://%' (6,807 rows)
--   - All Stage-5b bulk merges (evidence_pointer LIKE 'merge://%'
--     ingested_at >= '2026-04-19 16:00:00+00') (6,807 rows)
--   - All persons no longer referenced by any observation.
--
-- Preserves:
--   - The 6 Umayr observations (4 interactions + 1 person + 1 correction).
--   - The 4 Ramon non-bulk observations.
--   - The 2 pre-Stage-5b merges:
--       * e7afd7f4-6ce3-4b8a-b696-66f96cb7fa39 (umayr; dangling)
--       * 8fdf3f98-0c66-4ff2-ac7a-f66de7250b6d (ramon; links his 4 obs)
--
-- Expected post-counts (user_id = 'dbb398c2-1eff-4eee-ae10-bad13be5fda7'):
--   persons = 2 (Umayr + Ramon)
--   observations = 12
--     = 5 gmail-interactions + 1 wacli-interaction + 2 person + 1 correction
--       + 1 wacli-interaction(ramon) + 2 gmail-interactions(ramon)
--       + 2 merges (umayr + ramon)  (the wacli-contact for ramon is a
--       person; count above may differ by 1 depending on audit; gate
--       uses the verified real counts from pre-wipe SELECT).
--
-- Pre-wipe snapshot: outputs/cleanup-2026-04-20/pre-wipe-{observations,persons,links}.ndjson

BEGIN;

-- 1. Delete person_observation_links for the bulk rows.
DELETE FROM person_observation_links
 WHERE observation_id IN (
   SELECT id FROM observations
    WHERE user_id = 'dbb398c2-1eff-4eee-ae10-bad13be5fda7'
      AND (
        evidence_pointer LIKE 'manifest://%'
        OR (evidence_pointer LIKE 'merge://%'
            AND ingested_at >= '2026-04-19 16:00:00+00')
      )
 );

-- 2. Delete the bulk observations.
DELETE FROM observations
 WHERE user_id = 'dbb398c2-1eff-4eee-ae10-bad13be5fda7'
   AND (
     evidence_pointer LIKE 'manifest://%'
     OR (evidence_pointer LIKE 'merge://%'
         AND ingested_at >= '2026-04-19 16:00:00+00')
   );

-- 3. Delete persons with no remaining links.
DELETE FROM persons
 WHERE user_id = 'dbb398c2-1eff-4eee-ae10-bad13be5fda7'
   AND id NOT IN (
     SELECT DISTINCT person_id FROM person_observation_links
   );

COMMIT;
