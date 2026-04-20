-- Fixes two contract mismatches from P0-A vs P0-C:
-- 1. Add select_capability_reports RPC so the GET route can bypass RLS
--    under the ANON key (mirrors select_enriched_persons pattern —
--    .from("capability_reports").select() silently returns 0 rows
--    because auth.uid() is NULL in anon context).
-- 2. Change upsert_capability_report to return reported_at timestamptz
--    instead of integer row count, so the POST route can surface the
--    canonical server-side timestamp rather than a client-computed one.

-- ---------------------------------------------------------------------------
-- select_capability_reports — SECURITY DEFINER read path
-- ---------------------------------------------------------------------------

create or replace function public.select_capability_reports(
  p_user_id uuid
)
returns table (
  agent_id text,
  hostname text,
  channels jsonb,
  data_sources jsonb,
  tools jsonb,
  reported_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    r.agent_id,
    r.hostname,
    r.channels,
    r.data_sources,
    r.tools,
    r.reported_at
  from public.capability_reports r
  where r.user_id = p_user_id
  order by r.reported_at desc;
$$;

revoke all on function public.select_capability_reports(uuid) from public;
grant execute on function public.select_capability_reports(uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- upsert_capability_report — replace integer return with timestamptz
-- ---------------------------------------------------------------------------

drop function if exists public.upsert_capability_report(uuid, text, text, jsonb, jsonb, jsonb);

create or replace function public.upsert_capability_report(
  p_user_id uuid,
  p_agent_id text,
  p_hostname text,
  p_channels jsonb,
  p_data_sources jsonb,
  p_tools jsonb
)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reported_at timestamptz;
begin
  insert into public.capability_reports (
    user_id, agent_id, hostname, channels, data_sources, tools, reported_at
  )
  values (
    p_user_id,
    p_agent_id,
    p_hostname,
    coalesce(p_channels, '{}'::jsonb),
    coalesce(p_data_sources, '{}'::jsonb),
    coalesce(p_tools, '{}'::jsonb),
    now()
  )
  on conflict (user_id, agent_id) do update
    set hostname = excluded.hostname,
        channels = excluded.channels,
        data_sources = excluded.data_sources,
        tools = excluded.tools,
        reported_at = now()
  returning reported_at into v_reported_at;

  return v_reported_at;
end;
$$;

revoke all on function public.upsert_capability_report(uuid, text, text, jsonb, jsonb, jsonb) from public;
grant execute on function public.upsert_capability_report(uuid, text, text, jsonb, jsonb, jsonb) to authenticated, service_role;
