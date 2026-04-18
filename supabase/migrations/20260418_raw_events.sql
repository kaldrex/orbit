-- Immutable append-only ledger of source-level events.
--
-- Every channel connector writes here, idempotent on
-- (user_id, source, source_event_id). Downstream projections
-- (interactions, persons, packet cache) all rebuild from this table.
--
-- RLS: users read/write their own rows. No UPDATE/DELETE policies —
-- the ledger is append-only by contract. To correct a row, insert a
-- new one pointing back via raw_ref; application layer picks the
-- newest by (source, source_event_id).

create table if not exists public.raw_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  -- provenance
  source text not null check (source in ('whatsapp','gmail','calendar','slack','linear')),
  source_event_id text not null,
  channel text not null,
  connector_version text,

  -- time
  occurred_at timestamptz not null,
  ingested_at timestamptz not null default now(),

  -- shape
  direction text check (direction is null or direction in ('in','out')),
  thread_id text,
  participants_raw jsonb not null default '[]'::jsonb,
  participant_phones text[] not null default array[]::text[],
  participant_emails text[] not null default array[]::text[],
  body_preview text,
  attachments_present boolean not null default false,

  -- full payload or reference to one
  raw_ref jsonb,

  unique (user_id, source, source_event_id)
);

create index if not exists raw_events_user_occurred_at_idx
  on public.raw_events (user_id, occurred_at desc);
create index if not exists raw_events_user_thread_idx
  on public.raw_events (user_id, thread_id) where thread_id is not null;
create index if not exists raw_events_user_source_idx
  on public.raw_events (user_id, source);
create index if not exists raw_events_user_emails_gin
  on public.raw_events using gin (participant_emails);
create index if not exists raw_events_user_phones_gin
  on public.raw_events using gin (participant_phones);

alter table public.raw_events enable row level security;

drop policy if exists "users read own raw_events" on public.raw_events;
create policy "users read own raw_events" on public.raw_events
  for select using (auth.uid() = user_id);

drop policy if exists "users insert own raw_events" on public.raw_events;
create policy "users insert own raw_events" on public.raw_events
  for insert with check (auth.uid() = user_id);
