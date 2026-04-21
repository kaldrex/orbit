-- Phase 5 — Living Orbit: pg_cron schedules that enqueue jobs on a cadence.
--
-- One-time prerequisite: pg_cron must be enabled in the Supabase project
-- (Dashboard → Database → Extensions → pg_cron, or this migration will
-- attempt CREATE EXTENSION itself — Supabase projects on v1.1+ allow it).
-- If the extension isn't enabled, the CREATE EXTENSION line errors out
-- and the rest of the migration is skipped; enable it in the dashboard
-- then rerun.
--
-- Three schedules land, all keyed off dbb398c2-1eff-4eee-ae10-bad13be5fda7
-- (Sanchay — the V0 single-founder user). When we onboard a second
-- founder, swap the per-user SQL for a row-wise scan of `auth.users`.
--
--   every 15 min → enqueue_job(user, 'observer', {since: watermark})
--                  when new raw_events since last watermark exist
--   every 1 hour → enqueue_job(user, 'meeting_sync', {})
--   every 14 days → enqueue_job(user, 'enricher', {persons: [...stale]})
--
-- Watermark: we track a per-user "last observer tick" on
-- observer_watermarks so cron can scan raw_events since that tick
-- without re-enqueueing an identical job every 15 min.

-- --------------------------------------------------------------------------
-- Extension. Supabase requires service_role to create; migrations run as
-- postgres, so this is fine in practice. If your project predates v1.1
-- the one-time enable is: Dashboard → Database → Extensions → pg_cron.
-- --------------------------------------------------------------------------

create extension if not exists pg_cron;

-- --------------------------------------------------------------------------
-- observer_watermarks: one row per user, last time we enqueued an observer
-- tick. Used to gate the 15-min cron so it only enqueues when there's
-- new raw-event signal since the last tick.
-- --------------------------------------------------------------------------

create table if not exists public.observer_watermarks (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_tick_at timestamptz not null default '1970-01-01T00:00:00Z'::timestamptz
);

alter table public.observer_watermarks enable row level security;

drop policy if exists "users select own watermarks" on public.observer_watermarks;
create policy "users select own watermarks" on public.observer_watermarks
  for select using (auth.uid() = user_id);

-- --------------------------------------------------------------------------
-- cron_enqueue_observer_ticks
--   For every user that has at least one raw_event newer than their
--   watermark, enqueue an 'observer' job and bump the watermark.
--   Emits at most one job per user per tick.
-- --------------------------------------------------------------------------

create or replace function public.cron_enqueue_observer_ticks()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_since timestamptz;
  v_count integer := 0;
  v_payload jsonb;
begin
  -- Seed watermarks for any user missing a row so the first tick still enqueues.
  insert into public.observer_watermarks (user_id)
    select distinct re.user_id
      from public.raw_events re
      left join public.observer_watermarks w on w.user_id = re.user_id
     where w.user_id is null
  on conflict do nothing;

  for r in
    select w.user_id, w.last_tick_at
      from public.observer_watermarks w
  loop
    -- Does this user have any raw_events strictly newer than the last tick?
    if exists (
      select 1 from public.raw_events re
       where re.user_id = r.user_id
         and re.ingested_at > r.last_tick_at
       limit 1
    ) then
      v_since := r.last_tick_at;
      v_payload := jsonb_build_object('since', to_char(v_since, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF'));
      perform public.enqueue_job(r.user_id, 'observer', v_payload);
      update public.observer_watermarks
         set last_tick_at = now()
       where user_id = r.user_id;
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.cron_enqueue_observer_ticks() from public;
grant execute on function public.cron_enqueue_observer_ticks() to service_role;

-- --------------------------------------------------------------------------
-- cron_enqueue_enricher_ticks
--   Every 14 days, for every user with persons that haven't been
--   person-enriched in the last 14 days, enqueue an enricher job with the
--   stale person_ids in the payload.
-- --------------------------------------------------------------------------

create or replace function public.cron_enqueue_enricher_ticks()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_stale_ids uuid[];
  v_count integer := 0;
begin
  for r in select distinct user_id from public.persons
  loop
    -- persons whose most-recent kind:"person" observation is older than 14d,
    -- OR who have no person-kind observation at all.
    with latest as (
      select distinct on (pol.person_id)
             pol.person_id, o.observed_at
        from public.person_observation_links pol
        join public.observations o on o.id = pol.observation_id
       where o.user_id = r.user_id
         and o.kind = 'person'
       order by pol.person_id, o.observed_at desc
    )
    select coalesce(array_agg(p.id), array[]::uuid[])
      into v_stale_ids
      from public.persons p
      left join latest l on l.person_id = p.id
     where p.user_id = r.user_id
       and (l.observed_at is null or l.observed_at < now() - interval '14 days')
     limit 500;

    if v_stale_ids is not null and array_length(v_stale_ids, 1) > 0 then
      perform public.enqueue_job(
        r.user_id,
        'enricher',
        jsonb_build_object('persons', to_jsonb(v_stale_ids))
      );
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.cron_enqueue_enricher_ticks() from public;
grant execute on function public.cron_enqueue_enricher_ticks() to service_role;

-- --------------------------------------------------------------------------
-- cron_enqueue_meeting_sync_ticks
--   Every 1 hour, enqueue a meeting_sync job per user. The agent
--   dispatches to orbit-meeting-brief SKILL.
-- --------------------------------------------------------------------------

create or replace function public.cron_enqueue_meeting_sync_ticks()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_count integer := 0;
begin
  for r in select id as user_id from auth.users
  loop
    perform public.enqueue_job(r.user_id, 'meeting_sync', '{}'::jsonb);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.cron_enqueue_meeting_sync_ticks() from public;
grant execute on function public.cron_enqueue_meeting_sync_ticks() to service_role;

-- --------------------------------------------------------------------------
-- pg_cron schedules.
--
-- Idempotent: cron.schedule returns an existing jobid on re-run; to
-- update we unschedule + reschedule by name (pg_cron >= 1.5 supports
-- schedule_by_name).
-- --------------------------------------------------------------------------

-- Observer tick — every 15 minutes.
select cron.unschedule('orbit-observer-tick')
 where exists (select 1 from cron.job where jobname = 'orbit-observer-tick');
select cron.schedule(
  'orbit-observer-tick',
  '*/15 * * * *',
  $$select public.cron_enqueue_observer_ticks();$$
);

-- Meeting sync tick — every hour.
select cron.unschedule('orbit-meeting-sync-tick')
 where exists (select 1 from cron.job where jobname = 'orbit-meeting-sync-tick');
select cron.schedule(
  'orbit-meeting-sync-tick',
  '0 * * * *',
  $$select public.cron_enqueue_meeting_sync_ticks();$$
);

-- Enricher tick — every 14 days. pg_cron doesn't have a 14-day primitive;
-- we approximate with "3am on the 1st and 15th of each month". Good
-- enough for a 14-day cadence and safe against DST.
select cron.unschedule('orbit-enricher-tick')
 where exists (select 1 from cron.job where jobname = 'orbit-enricher-tick');
select cron.schedule(
  'orbit-enricher-tick',
  '0 3 1,15 * *',
  $$select public.cron_enqueue_enricher_ticks();$$
);
