-- pg_cron schedule for the delta-bulk enricher.
--
-- Runs daily at 3 AM UTC. Enqueues ONE orbit-enricher-delta job per user
-- with {scope: "active_since_days_ago", days: 1} — the SKILL picks
-- candidates with activity in the last 24h and enriches them.
--
-- If the candidate set is larger than one batch of 30, the SKILL handles
-- it inside one agent turn (loop + multiple Haiku calls). If that proves
-- to be too slow for the 30-min systemd timeout, we can split into
-- multiple queued jobs in a later migration.

create extension if not exists pg_cron;

create or replace function public.cron_enqueue_enricher_delta_ticks()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
  v_user record;
begin
  for v_user in
    select distinct user_id from public.observations
    union
    select distinct user_id from public.person_snapshots
  loop
    perform public.enqueue_job(
      v_user.user_id,
      'enricher_delta',
      jsonb_build_object('scope', 'active_since_days_ago', 'days', 1)
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.cron_enqueue_enricher_delta_ticks() from public;
grant execute on function public.cron_enqueue_enricher_delta_ticks()
  to authenticated, service_role;

-- Drop any prior schedule with the same name (idempotent).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'orbit-enricher-delta-tick') then
    perform cron.unschedule('orbit-enricher-delta-tick');
  end if;
end;
$$;

select cron.schedule(
  'orbit-enricher-delta-tick',
  '0 3 * * *',   -- daily at 3 AM UTC
  $$select public.cron_enqueue_enricher_delta_ticks();$$
);
