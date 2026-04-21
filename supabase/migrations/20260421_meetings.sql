-- Meetings (pre-meeting briefs) — Phase 4 subagent B.
--
-- One row per (user_id, meeting_id) where meeting_id is the Google
-- Calendar event id (or any stable string the calendar source returns).
-- Populated by the orbit-meeting-brief SKILL running on the founder's
-- claw: that skill pulls upcoming events via `gws calendar +agenda`,
-- builds attendee context from Orbit, asks Haiku to synthesize a brief,
-- and POSTs the result here.
--
-- Dashboard reads via GET /api/v1/meetings/upcoming → renders an
-- upcoming-meetings strip above the filter pills.
--
-- Storage pattern mirrors capability_reports: SECURITY DEFINER RPCs
-- bypass the ANON context's null auth.uid() while keeping RLS on the
-- base table.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Base table.
-- ---------------------------------------------------------------------------

create table if not exists public.meetings (
  user_id uuid not null references auth.users(id) on delete cascade,
  meeting_id text not null,
  title text,
  start_at timestamptz not null,
  end_at timestamptz,
  attendees_json jsonb not null default '[]'::jsonb,
  brief_md text,
  generated_at timestamptz not null default now(),
  primary key (user_id, meeting_id)
);

create index if not exists meetings_user_start_idx
  on public.meetings (user_id, start_at);

-- ---------------------------------------------------------------------------
-- RLS: users select their own rows; service_role + SECURITY DEFINER
-- RPCs handle writes.
-- ---------------------------------------------------------------------------

alter table public.meetings enable row level security;

drop policy if exists "users select own meetings" on public.meetings;
create policy "users select own meetings" on public.meetings
  for select using (auth.uid() = user_id);

-- No user-level INSERT/UPDATE/DELETE policy: writes funnel through the
-- SECURITY DEFINER RPC below; service_role bypasses RLS.

-- ---------------------------------------------------------------------------
-- upsert_meeting — idempotent write. Returns the row's generated_at.
-- ---------------------------------------------------------------------------

create or replace function public.upsert_meeting(
  p_user_id uuid,
  p_meeting_id text,
  p_title text,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_attendees_json jsonb,
  p_brief_md text
)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_generated_at timestamptz;
begin
  insert into public.meetings (
    user_id,
    meeting_id,
    title,
    start_at,
    end_at,
    attendees_json,
    brief_md,
    generated_at
  )
  values (
    p_user_id,
    p_meeting_id,
    p_title,
    p_start_at,
    p_end_at,
    coalesce(p_attendees_json, '[]'::jsonb),
    p_brief_md,
    now()
  )
  on conflict (user_id, meeting_id) do update
    set title = excluded.title,
        start_at = excluded.start_at,
        end_at = excluded.end_at,
        attendees_json = excluded.attendees_json,
        -- Only overwrite brief_md when the caller provides a new one;
        -- a calendar-only refresh shouldn't wipe a previously
        -- synthesized brief.
        brief_md = coalesce(excluded.brief_md, public.meetings.brief_md),
        generated_at = now()
  returning generated_at into v_generated_at;

  return v_generated_at;
end;
$$;

revoke all on function public.upsert_meeting(uuid, text, text, timestamptz, timestamptz, jsonb, text) from public;
grant execute on function public.upsert_meeting(uuid, text, text, timestamptz, timestamptz, jsonb, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- select_upcoming_meetings — SECURITY DEFINER read path.
-- Returns rows whose start_at lands in [NOW(), NOW() + horizon_hours),
-- ordered by start_at ASC.
-- ---------------------------------------------------------------------------

create or replace function public.select_upcoming_meetings(
  p_user_id uuid,
  p_horizon_hours integer default 72
)
returns table (
  meeting_id text,
  title text,
  start_at timestamptz,
  end_at timestamptz,
  attendees_json jsonb,
  brief_md text,
  generated_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    m.meeting_id,
    m.title,
    m.start_at,
    m.end_at,
    m.attendees_json,
    m.brief_md,
    m.generated_at
  from public.meetings m
  where m.user_id = p_user_id
    and m.start_at >= now()
    and m.start_at < now() + make_interval(hours => greatest(p_horizon_hours, 0))
  order by m.start_at asc;
$$;

revoke all on function public.select_upcoming_meetings(uuid, integer) from public;
grant execute on function public.select_upcoming_meetings(uuid, integer) to anon, authenticated, service_role;
