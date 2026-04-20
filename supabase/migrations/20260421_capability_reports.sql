-- Capability reports from agents (OpenClaw instances).
--
-- Each founder's agent posts a snapshot of what it can do: which
-- channels are connected (whatsapp/gmail/gcal/contacts), which data
-- sources are queryable (wacli/gmail-api/gcal-api/...), which tools
-- are installed (observer/resolver/rules/cli). One row per
-- (user_id, agent_id) — upsert on every report.
--
-- Read path: onboarding UI polls GET /api/v1/capabilities to show
-- the founder what their agent is ready for.

create extension if not exists pgcrypto;

create table if not exists public.capability_reports (
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id text not null,
  hostname text,
  channels jsonb not null default '{}'::jsonb,
  data_sources jsonb not null default '{}'::jsonb,
  tools jsonb not null default '{}'::jsonb,
  reported_at timestamptz not null default now(),
  primary key (user_id, agent_id)
);

create index if not exists capability_reports_user_recent_idx
  on public.capability_reports (user_id, reported_at desc);

-- ---------------------------------------------------------------------------
-- RLS: users read their own rows; service_role handles writes. Agent
-- writes go through the API route which uses the service key.
-- ---------------------------------------------------------------------------

alter table public.capability_reports enable row level security;

drop policy if exists "users select own capability_reports" on public.capability_reports;
create policy "users select own capability_reports" on public.capability_reports
  for select using (auth.uid() = user_id);

-- No user-level INSERT/UPDATE/DELETE policy: writes are funnelled
-- through the SECURITY DEFINER RPC below (called by the service-role
-- API route). service_role bypasses RLS.

-- ---------------------------------------------------------------------------
-- upsert_capability_report: idempotent write. Returns 1 on success.
-- ---------------------------------------------------------------------------

create or replace function public.upsert_capability_report(
  p_user_id uuid,
  p_agent_id text,
  p_hostname text,
  p_channels jsonb,
  p_data_sources jsonb,
  p_tools jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
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
        reported_at = now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.upsert_capability_report(uuid, text, text, jsonb, jsonb, jsonb) from public;
grant execute on function public.upsert_capability_report(uuid, text, text, jsonb, jsonb, jsonb) to authenticated, service_role;
