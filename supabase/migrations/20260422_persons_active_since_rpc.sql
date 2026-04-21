-- Phase 2 / delta-bulk enricher — persons with activity in a window.
--
-- Given a user + since timestamp, returns person_ids that have either:
--   (a) one or more observations linked within (since .. now], OR
--   (b) one or more snapshots within that window (own-writes count).
--
-- Used by orbit-enricher-delta SKILL to pick candidates. Pure Postgres,
-- no LLM. When p_needs_enrichment=true, drops persons with a fresh
-- pass_kind='summary' snapshot (< 7 days old) — no point re-summarizing
-- what was just summarized.
--
-- Returns: (person_id uuid, last_activity_at timestamptz, activity_count int)
-- Ordered by last_activity_at DESC.

create or replace function public.select_persons_active_since(
  p_user_id uuid,
  p_since timestamptz,
  p_needs_enrichment boolean default false
)
returns table (
  person_id uuid,
  last_activity_at timestamptz,
  activity_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_user_id is null then
    raise exception 'select_persons_active_since: p_user_id is required';
  end if;
  if p_since is null then
    raise exception 'select_persons_active_since: p_since is required';
  end if;

  return query
    with obs_activity as (
      select l.person_id,
             max(o.observed_at) as last_at,
             count(*)::integer as cnt
        from public.observations o
        join public.person_observation_links l on l.observation_id = o.id
       where o.user_id = p_user_id
         and o.observed_at >= p_since
       group by l.person_id
    ),
    snap_activity as (
      select s.person_id,
             max(s.pass_at) as last_at,
             count(*)::integer as cnt
        from public.person_snapshots s
       where s.user_id = p_user_id
         and s.pass_at >= p_since
       group by s.person_id
    ),
    merged as (
      select coalesce(o.person_id, s.person_id) as pid,
             greatest(coalesce(o.last_at, '-infinity'::timestamptz),
                      coalesce(s.last_at, '-infinity'::timestamptz)) as last_at,
             coalesce(o.cnt, 0) + coalesce(s.cnt, 0) as cnt
        from obs_activity o
        full outer join snap_activity s on s.person_id = o.person_id
    ),
    fresh_summary as (
      select s.person_id
        from public.person_snapshots s
       where s.user_id = p_user_id
         and s.pass_kind = 'summary'
         and s.pass_at >= now() - interval '7 days'
    )
    select m.pid, m.last_at, m.cnt
      from merged m
     where m.pid is not null
       and (
         not p_needs_enrichment
         or m.pid not in (select fs.person_id from fresh_summary fs)
       )
     order by m.last_at desc;
end;
$$;

revoke all on function public.select_persons_active_since(uuid, timestamptz, boolean) from public;
grant execute on function public.select_persons_active_since(uuid, timestamptz, boolean)
  to anon, authenticated, service_role;
