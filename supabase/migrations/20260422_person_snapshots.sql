-- Phase 2 — Per-pass card snapshots.
--
-- Stores one row per enrichment / resolver / summary / correction pass
-- against a person. The row is an immutable snapshot of the card state
-- at that pass boundary plus LLM-generated `diff_summary` + per-field
-- `confidence_delta` that capture "what changed this pass."
--
-- Observations remain the append-only source of truth. person_snapshots
-- is a UI-facing projection that (a) makes pass boundaries explicit and
-- (b) preserves the LLM's diff_summary text, which is not reconstructible
-- from observations alone. This small impurity is documented — the tradeoff
-- is a faster, richer "Evolution" UI without collapsing observations into
-- an opaque blob.
--
-- Three SECURITY DEFINER RPCs:
--   upsert_person_snapshot        — write one snapshot row (enricher/combiner)
--   select_person_snapshots       — read newest-first stack (UI panel)
--   select_latest_summary_snapshot — fetch the latest pass_kind='summary'
--                                    snapshot (card-assembler headline)
--
-- RLS: users SELECT their own rows. Writes go through the RPCs.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Table: public.person_snapshots
-- ---------------------------------------------------------------------------

create table if not exists public.person_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  person_id uuid not null references public.persons(id) on delete cascade,
  pass_at timestamptz not null default now(),
  pass_kind text not null check (pass_kind in ('enricher','resolver','summary','correction')),
  card_state jsonb not null default '{}'::jsonb,
  evidence_pointer_ids uuid[] not null default '{}',
  diff_summary text not null default '',
  confidence_delta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Primary lookup: "newest snapshots for this person" (UI evolution stack).
create index if not exists person_snapshots_user_person_time_idx
  on public.person_snapshots (user_id, person_id, pass_at desc);

-- Secondary lookup: "latest summary snapshot for this person" (assembler).
create index if not exists person_snapshots_user_person_kind_time_idx
  on public.person_snapshots (user_id, person_id, pass_kind, pass_at desc);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.person_snapshots enable row level security;

drop policy if exists "users select own snapshots" on public.person_snapshots;
create policy "users select own snapshots" on public.person_snapshots
  for select using (auth.uid() = user_id);

-- No user-level INSERT/UPDATE/DELETE policy — writes funnel through the
-- SECURITY DEFINER RPCs below.

-- ---------------------------------------------------------------------------
-- upsert_person_snapshot(...) RETURNS uuid
-- Insert a new snapshot row. Returns the new id.
-- ---------------------------------------------------------------------------

create or replace function public.upsert_person_snapshot(
  p_user_id uuid,
  p_person_id uuid,
  p_pass_kind text,
  p_card_state jsonb,
  p_evidence_pointer_ids uuid[],
  p_diff_summary text,
  p_confidence_delta jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_owner uuid;
begin
  if p_user_id is null then
    raise exception 'upsert_person_snapshot: p_user_id is required';
  end if;
  if p_person_id is null then
    raise exception 'upsert_person_snapshot: p_person_id is required';
  end if;
  if p_pass_kind is null or p_pass_kind not in ('enricher','resolver','summary','correction') then
    raise exception 'upsert_person_snapshot: p_pass_kind must be enricher|resolver|summary|correction';
  end if;

  -- Cross-tenant guard: the person must belong to p_user_id.
  select p.user_id into v_owner from public.persons p where p.id = p_person_id;
  if v_owner is null then
    raise exception 'upsert_person_snapshot: person_id not found';
  end if;
  if v_owner <> p_user_id then
    raise exception 'upsert_person_snapshot: person_id belongs to a different user';
  end if;

  insert into public.person_snapshots (
    user_id, person_id, pass_kind, card_state,
    evidence_pointer_ids, diff_summary, confidence_delta
  )
  values (
    p_user_id, p_person_id, p_pass_kind,
    coalesce(p_card_state, '{}'::jsonb),
    coalesce(p_evidence_pointer_ids, '{}'::uuid[]),
    coalesce(p_diff_summary, ''),
    coalesce(p_confidence_delta, '{}'::jsonb)
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.upsert_person_snapshot(uuid, uuid, text, jsonb, uuid[], text, jsonb) from public;
grant execute on function public.upsert_person_snapshot(uuid, uuid, text, jsonb, uuid[], text, jsonb)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- select_person_snapshots(p_user_id, p_person_id, p_limit) RETURNS setof row
-- Newest-first. Used by the UI Evolution stack.
-- ---------------------------------------------------------------------------

create or replace function public.select_person_snapshots(
  p_user_id uuid,
  p_person_id uuid,
  p_limit integer default 50
)
returns table (
  id uuid,
  person_id uuid,
  pass_at timestamptz,
  pass_kind text,
  card_state jsonb,
  evidence_pointer_ids uuid[],
  diff_summary text,
  confidence_delta jsonb,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_user_id is null or p_person_id is null then
    raise exception 'select_person_snapshots: p_user_id and p_person_id are required';
  end if;

  return query
    select s.id, s.person_id, s.pass_at, s.pass_kind, s.card_state,
           s.evidence_pointer_ids, s.diff_summary, s.confidence_delta, s.created_at
      from public.person_snapshots s
     where s.user_id = p_user_id
       and s.person_id = p_person_id
     order by s.pass_at desc, s.id desc
     limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

revoke all on function public.select_person_snapshots(uuid, uuid, integer) from public;
grant execute on function public.select_person_snapshots(uuid, uuid, integer)
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- select_latest_summary_snapshot(p_user_id, p_person_id) RETURNS row or empty
-- Card-assembler uses this to prefer the combiner summary as headline.
-- ---------------------------------------------------------------------------

create or replace function public.select_latest_summary_snapshot(
  p_user_id uuid,
  p_person_id uuid
)
returns table (
  id uuid,
  person_id uuid,
  pass_at timestamptz,
  pass_kind text,
  card_state jsonb,
  evidence_pointer_ids uuid[],
  diff_summary text,
  confidence_delta jsonb,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_user_id is null or p_person_id is null then
    raise exception 'select_latest_summary_snapshot: p_user_id and p_person_id are required';
  end if;

  return query
    select s.id, s.person_id, s.pass_at, s.pass_kind, s.card_state,
           s.evidence_pointer_ids, s.diff_summary, s.confidence_delta, s.created_at
      from public.person_snapshots s
     where s.user_id = p_user_id
       and s.person_id = p_person_id
       and s.pass_kind = 'summary'
     order by s.pass_at desc, s.id desc
     limit 1;
end;
$$;

revoke all on function public.select_latest_summary_snapshot(uuid, uuid) from public;
grant execute on function public.select_latest_summary_snapshot(uuid, uuid)
  to anon, authenticated, service_role;
