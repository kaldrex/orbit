-- Append-only basket of observations.
--
-- Every write to Orbit comes in here. Observations are immutable: to
-- correct, emit a new kind:'correction' observation; to un-merge, emit
-- kind:'split'. Persons are an emergent projection produced by the
-- resolver pass (see 20260419_persons.sql).
--
-- Idempotency: dedup_key is computed by a BEFORE INSERT trigger from
-- kind + evidence_pointer (+ correction-specific content hash). Same
-- observation re-posted = no-op via ON CONFLICT DO NOTHING in the
-- upsert_observations RPC.
--
-- RLS: users read/write their own rows. Append-only by contract —
-- no UPDATE/DELETE policies.

create extension if not exists pgcrypto;

create table if not exists public.observations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  -- when the agent observed the thing
  observed_at timestamptz not null,
  -- when orbit received it
  ingested_at timestamptz not null default now(),

  -- provenance
  observer text not null check (observer in ('wazowski')),
  kind text not null check (kind in ('interaction','person','correction','merge','split')),
  evidence_pointer text not null,
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  reasoning text not null check (length(reasoning) >= 1),

  -- kind-specific body
  payload jsonb not null,

  -- computed by trigger; used for idempotency
  dedup_key text not null,

  unique (user_id, dedup_key)
);

create or replace function public.compute_observation_dedup_key()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  v_tail text;
begin
  if new.kind = 'correction' then
    v_tail := coalesce(new.payload->>'target_person_id', '') || ':' ||
              coalesce(new.payload->>'field', '') || ':' ||
              coalesce(new.payload->>'new_value', '');
  else
    v_tail := '';
  end if;
  new.dedup_key := encode(
    digest(
      new.kind || ':' || new.evidence_pointer || ':' || v_tail,
      'sha256'
    ),
    'hex'
  );
  return new;
end;
$$;

drop trigger if exists observations_compute_dedup_key on public.observations;
create trigger observations_compute_dedup_key
  before insert on public.observations
  for each row
  execute function public.compute_observation_dedup_key();

create index if not exists observations_user_observed_at_idx
  on public.observations (user_id, observed_at desc);
create index if not exists observations_user_kind_idx
  on public.observations (user_id, kind);
create index if not exists observations_user_evidence_idx
  on public.observations (user_id, evidence_pointer);
create index if not exists observations_user_payload_gin
  on public.observations using gin (payload);

alter table public.observations enable row level security;

drop policy if exists "users read own observations" on public.observations;
create policy "users read own observations" on public.observations
  for select using (auth.uid() = user_id);

drop policy if exists "users insert own observations" on public.observations;
create policy "users insert own observations" on public.observations
  for insert with check (auth.uid() = user_id);
