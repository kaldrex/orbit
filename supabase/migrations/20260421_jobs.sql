-- Phase 5 — Living Orbit: background-job queue.
--
-- Stores one row per enqueued unit of work an agent (running on claw) must
-- claim, execute, and report. Three SECURITY DEFINER RPCs form the write path:
--   enqueue_job        — insert a pending row (scheduler / user / cron calls)
--   claim_next_job     — atomically pick the oldest unclaimed row for a user
--                        whose kind matches the agent's capability set
--   report_job_result  — mark a claimed row completed with status + result
--
-- RLS: users SELECT their own rows. Writes go through the RPCs (which run
-- as SECURITY DEFINER and enforce user_id match internally). This mirrors
-- the pattern used by meetings, capability_reports, and person_topics.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Table: public.jobs
-- ---------------------------------------------------------------------------

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  claimed_at timestamptz,
  claimed_by text,
  completed_at timestamptz,
  result jsonb,
  attempts integer not null default 0,
  created_at timestamptz not null default now()
);

-- Index supports "oldest unclaimed of kinds[]" selection.
create index if not exists jobs_user_unclaimed_idx
  on public.jobs (user_id, kind, created_at)
  where claimed_at is null;

-- Index for dashboards / debugging (see recent completions).
create index if not exists jobs_user_created_idx
  on public.jobs (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS: users see their own jobs; no direct writes allowed outside RPCs.
-- ---------------------------------------------------------------------------

alter table public.jobs enable row level security;

drop policy if exists "users select own jobs" on public.jobs;
create policy "users select own jobs" on public.jobs
  for select using (auth.uid() = user_id);

-- No user-level INSERT/UPDATE/DELETE policy — writes funnel through the
-- SECURITY DEFINER RPCs below, matching the meetings + capability pattern.

-- ---------------------------------------------------------------------------
-- enqueue_job(p_user_id, p_kind, p_payload) RETURNS uuid
-- Simple insert wrapper. Returns the new job id.
-- ---------------------------------------------------------------------------

create or replace function public.enqueue_job(
  p_user_id uuid,
  p_kind text,
  p_payload jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_user_id is null then
    raise exception 'enqueue_job: p_user_id is required';
  end if;
  if p_kind is null or length(trim(p_kind)) = 0 then
    raise exception 'enqueue_job: p_kind is required';
  end if;

  insert into public.jobs (user_id, kind, payload)
  values (p_user_id, p_kind, coalesce(p_payload, '{}'::jsonb))
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.enqueue_job(uuid, text, jsonb) from public;
grant execute on function public.enqueue_job(uuid, text, jsonb)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- claim_next_job(p_user_id, p_agent_id, p_kinds) RETURNS row
--
-- Atomic claim: picks the oldest pending row for p_user_id whose kind is in
-- p_kinds[], locks it with SKIP LOCKED so parallel claimers don't collide,
-- and marks claimed_at = now(), claimed_by = p_agent_id, attempts += 1.
-- Returns the job envelope {id, kind, payload} (or empty result set if the
-- queue is empty / no matching kinds).
-- ---------------------------------------------------------------------------

create or replace function public.claim_next_job(
  p_user_id uuid,
  p_agent_id text,
  p_kinds text[]
)
returns table (
  id uuid,
  kind text,
  payload jsonb,
  attempts integer,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_user_id is null then
    raise exception 'claim_next_job: p_user_id is required';
  end if;
  if p_agent_id is null or length(trim(p_agent_id)) = 0 then
    raise exception 'claim_next_job: p_agent_id is required';
  end if;
  if p_kinds is null or array_length(p_kinds, 1) is null then
    raise exception 'claim_next_job: p_kinds must be a non-empty array';
  end if;

  -- SELECT ... FOR UPDATE SKIP LOCKED: a competing worker calling the same
  -- RPC at the same instant will skip this row and pick the next one.
  select j.id
    into v_id
    from public.jobs j
   where j.user_id = p_user_id
     and j.kind = any(p_kinds)
     and j.claimed_at is null
   order by j.created_at asc
   limit 1
   for update skip locked;

  if v_id is null then
    return;
  end if;

  return query
    update public.jobs j
       set claimed_at = now(),
           claimed_by = p_agent_id,
           attempts = j.attempts + 1
     where j.id = v_id
    returning j.id, j.kind, j.payload, j.attempts, j.created_at;
end;
$$;

revoke all on function public.claim_next_job(uuid, text, text[]) from public;
grant execute on function public.claim_next_job(uuid, text, text[])
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- report_job_result(p_job_id, p_user_id, p_status, p_result) RETURNS boolean
--
-- Marks a claimed job completed. status must be 'succeeded' | 'failed' |
-- 'retry'. When status='retry', we clear claimed_at/by so the job is
-- re-claimable (attempts keeps incrementing); otherwise we set completed_at.
-- Returns true when a row was updated (job belonged to the user and was
-- previously claimed), false otherwise.
-- ---------------------------------------------------------------------------

create or replace function public.report_job_result(
  p_job_id uuid,
  p_user_id uuid,
  p_status text,
  p_result jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_updated integer;
begin
  if p_job_id is null or p_user_id is null then
    raise exception 'report_job_result: p_job_id and p_user_id are required';
  end if;
  if p_status not in ('succeeded', 'failed', 'retry') then
    raise exception 'report_job_result: p_status must be succeeded|failed|retry';
  end if;

  if p_status = 'retry' then
    update public.jobs j
       set claimed_at = null,
           claimed_by = null,
           result = jsonb_build_object('status', p_status, 'data', coalesce(p_result, '{}'::jsonb))
     where j.id = p_job_id
       and j.user_id = p_user_id;
  else
    update public.jobs j
       set completed_at = now(),
           result = jsonb_build_object('status', p_status, 'data', coalesce(p_result, '{}'::jsonb))
     where j.id = p_job_id
       and j.user_id = p_user_id;
  end if;

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

revoke all on function public.report_job_result(uuid, uuid, text, jsonb) from public;
grant execute on function public.report_job_result(uuid, uuid, text, jsonb)
  to authenticated, service_role;
