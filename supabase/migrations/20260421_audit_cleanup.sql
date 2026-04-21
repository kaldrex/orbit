-- 20260421_audit_cleanup.sql
--
-- Three-part cleanup migration from the 2026-04-21 backend audit:
--
--   1. Back-fill supabase_migrations.schema_migrations for the 20 .sql
--      files that were applied to live Supabase but never recorded. Without
--      this, a fresh `supabase db reset` would flag them as "never applied"
--      and skip them — or on a fresh clone, apply would double-apply.
--   2. Drop 3 dead RPCs superseded by newer implementations:
--        - record_merge_audit (superseded by record_merge_audit_rpc)
--        - select_person_observations (superseded by select_observations)
--        - select_persons_page (superseded by select_enriched_persons)
--   3. Delete 1 audit-probe meeting + 3 orphan observations (auto-link residue
--      from 2026-04-19..2026-04-21 audit sessions).
--
-- Every statement is idempotent. Safe to re-apply.

-- ---------------------------------------------------------------------------
-- 1. Back-fill supabase_migrations.schema_migrations.
-- ---------------------------------------------------------------------------

-- from: 20260418_raw_events.sql
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20260418900001', 'raw_events', ARRAY[$stmt_20260418900001$create table if not exists public.raw_events (
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
  for insert with check (auth.uid() = user_id);$stmt_20260418900001$])
on conflict (version) do nothing;

-- from: 20260418_upsert_raw_events_rpc.sql
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20260418900002', 'upsert_raw_events_rpc', ARRAY[$stmt_20260418900002$create or replace function public.upsert_raw_events(
  p_user_id uuid,
  p_rows jsonb
) returns table (inserted int, updated int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted int := 0;
  v_row jsonb;
begin
  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    insert into public.raw_events (
      user_id, source, source_event_id, channel, connector_version,
      occurred_at, direction, thread_id,
      participants_raw, participant_phones, participant_emails,
      body_preview, attachments_present, raw_ref
    ) values (
      p_user_id,
      v_row->>'source',
      v_row->>'source_event_id',
      v_row->>'channel',
      v_row->>'connector_version',
      (v_row->>'occurred_at')::timestamptz,
      v_row->>'direction',
      v_row->>'thread_id',
      coalesce(v_row->'participants_raw', '[]'::jsonb),
      coalesce(
        (select array_agg(value::text) from jsonb_array_elements_text(v_row->'participant_phones')),
        array[]::text[]
      ),
      coalesce(
        (select array_agg(value::text) from jsonb_array_elements_text(v_row->'participant_emails')),
        array[]::text[]
      ),
      v_row->>'body_preview',
      coalesce((v_row->>'attachments_present')::boolean, false),
      v_row->'raw_ref'
    )
    on conflict (user_id, source, source_event_id) do nothing;

    if FOUND then
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  inserted := v_inserted;
  updated := (jsonb_array_length(p_rows) - v_inserted);
  return next;
end;
$$;

revoke all on function public.upsert_raw_events(uuid, jsonb) from public;
grant execute on function public.upsert_raw_events(uuid, jsonb) to anon, authenticated, service_role;$stmt_20260418900002$])
on conflict (version) do nothing;

-- from: 20260419_observations.sql
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20260419900001', 'observations', ARRAY[$stmt_20260419900001$create extension if not exists pgcrypto;

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
  for insert with check (auth.uid() = user_id);$stmt_20260419900001$])
on conflict (version) do nothing;

-- from: 20260419_persons.sql
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20260419900002', 'persons', ARRAY[$stmt_20260419900002$create table if not exists public.persons (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists persons_user_idx on public.persons (user_id);

alter table public.persons enable row level security;

drop policy if exists "users read own persons" on public.persons;
create policy "users read own persons" on public.persons
  for select using (auth.uid() = user_id);

drop policy if exists "users insert own persons" on public.persons;
create policy "users insert own persons" on public.persons
  for insert with check (auth.uid() = user_id);

create table if not exists public.person_observation_links (
  person_id uuid not null references public.persons(id) on delete cascade,
  observation_id uuid not null references public.observations(id) on delete cascade,
  linked_at timestamptz not null default now(),
  linked_by_observation_id uuid references public.observations(id) on delete set null,
  primary key (person_id, observation_id)
);

create index if not exists person_observation_links_obs_idx
  on public.person_observation_links (observation_id);

alter table public.person_observation_links enable row level security;

-- A link is readable/writable if the person belongs to the caller.
drop policy if exists "users read own links" on public.person_observation_links;
create policy "users read own links" on public.person_observation_links
  for select using (
    exists (
      select 1 from public.persons p
      where p.id = person_observation_links.person_id
        and p.user_id = auth.uid()
    )
  );

drop policy if exists "users insert own links" on public.person_observation_links;
create policy "users insert own links" on public.person_observation_links
  for insert with check (
    exists (
      select 1 from public.persons p
      where p.id = person_observation_links.person_id
        and p.user_id = auth.uid()
    )
  );$stmt_20260419900002$])
on conflict (version) do nothing;

-- from: 20260419_select_observations_rpc.sql
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20260419900003', 'select_observations_rpc', ARRAY[$stmt_20260419900003$create or replace function public.select_observations(
  p_user_id uuid,
  p_since timestamptz default null,
  p_kind text default null,
  p_limit int default 1000,
  p_cursor uuid default null
) returns setof public.observations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cursor_observed_at timestamptz;
begin
  if p_cursor is not null then
    select observed_at into v_cursor_observed_at
      from public.observations
      where id = p_cursor and user_id = p_user_id;
  end if;

  return query
    select *
      from public.observations o
     where o.user_id = p_user_id
       and (p_since is null or o.observed_at >= p_since)
       and (p_kind is null or o.kind = p_kind)
       and (
         p_cursor is null
         or v_cursor_observed_at is null
         or o.observed_at < v_cursor_observed_at
         or (o.observed_at = v_cursor_observed_at and o.id < p_cursor)
       )
     order by o.observed_at desc, o.id desc
     limit least(greatest(p_limit, 1), 1000);
end;
$$;

revoke all on function public.select_observations(uuid, timestamptz, text, int, uuid) from public;
grant execute on function public.select_observations(uuid, timestamptz, text, int, uuid) to anon, authenticated, service_role;$stmt_20260419900003$])
on conflict (version) do nothing;

-- from: 20260419_upsert_observations_rpc.sql
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20260419900004', 'upsert_observations_rpc', ARRAY[$stmt_20260419900004$create or replace function public.upsert_observations(
  p_user_id uuid,
  p_rows jsonb
) returns table (inserted int, deduped int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted int := 0;
  v_row jsonb;
begin
  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    insert into public.observations (
      user_id, observed_at, observer, kind, evidence_pointer,
      confidence, reasoning, payload
    ) values (
      p_user_id,
      (v_row->>'observed_at')::timestamptz,
      v_row->>'observer',
      v_row->>'kind',
      v_row->>'evidence_pointer',
      (v_row->>'confidence')::numeric,
      v_row->>'reasoning',
      v_row->'payload'
    )
    on conflict (user_id, dedup_key) do nothing;

    if FOUND then
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  inserted := v_inserted;
  deduped := (jsonb_array_length(p_rows) - v_inserted);
  return next;
end;
$$;

revoke all on function public.upsert_observations(uuid, jsonb) from public;
grant execute on function public.upsert_observations(uuid, jsonb) to anon, authenticated, service_role;$stmt_20260419900004$])
on conflict (version) do nothing;

-- from: 20260419_select_person_observations_rpc.sql
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20260419900005', 'select_person_observations_rpc', ARRAY[$stmt_20260419900005$create or replace function public.select_person_observations(
  p_user_id uuid,
  p_person_id uuid
) returns setof public.observations
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.persons
    where id = p_person_id and user_id = p_user_id
  ) then
    return;
  end if;

  return query
    select o.*
      from public.observations o
      join public.person_observation_links l on l.observation_id = o.id
     where o.user_id = p_user_id
       and l.person_id = p_person_id
     order by o.observed_at asc;
end;
$$;

revoke all on function public.select_person_observations(uuid, uuid) from public;
grant execute on function public.select_person_observations(uuid, uuid) to anon, authenticated, service_role;$stmt_20260419900005$])
on conflict (version) do nothing;

-- from: 20260419_upsert_observations_auto_merge.sql
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20260419900006', 'upsert_observations_auto_merge', ARRAY[$stmt_20260419900006$create or replace function public.upsert_observations(
  p_user_id uuid,
  p_rows jsonb
) returns table (inserted int, deduped int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted int := 0;
  v_row jsonb;
  v_kind text;
  v_person_id uuid;
  v_obs_id uuid;
  v_merged_id_text text;
begin
  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_kind := v_row->>'kind';

    insert into public.observations (
      user_id, observed_at, observer, kind, evidence_pointer,
      confidence, reasoning, payload
    ) values (
      p_user_id,
      (v_row->>'observed_at')::timestamptz,
      v_row->>'observer',
      v_kind,
      v_row->>'evidence_pointer',
      (v_row->>'confidence')::numeric,
      v_row->>'reasoning',
      v_row->'payload'
    )
    on conflict (user_id, dedup_key) do nothing
    returning id into v_obs_id;

    if FOUND then
      v_inserted := v_inserted + 1;

      if v_kind = 'merge' then
        v_person_id := (v_row->'payload'->>'person_id')::uuid;

        -- Materialize the person row if it doesn't exist yet.
        insert into public.persons (id, user_id)
        values (v_person_id, p_user_id)
        on conflict (id) do nothing;

        -- Link every merged observation to this person.
        for v_merged_id_text in
          select value::text from jsonb_array_elements_text(v_row->'payload'->'merged_observation_ids')
        loop
          insert into public.person_observation_links (person_id, observation_id, linked_by_observation_id)
          values (v_person_id, v_merged_id_text::uuid, v_obs_id)
          on conflict (person_id, observation_id) do nothing;
        end loop;

        -- Also link the merge observation itself so it appears in reads.
        insert into public.person_observation_links (person_id, observation_id, linked_by_observation_id)
        values (v_person_id, v_obs_id, v_obs_id)
        on conflict (person_id, observation_id) do nothing;

      elsif v_kind = 'split' then
        v_person_id := (v_row->'payload'->>'person_id')::uuid;
        for v_merged_id_text in
          select value::text from jsonb_array_elements_text(v_row->'payload'->'split_off_observation_ids')
        loop
          delete from public.person_observation_links
           where person_id = v_person_id
             and observation_id = v_merged_id_text::uuid;
        end loop;

      elsif v_kind = 'correction' then
        -- Corrections carry a target_person_id. Link to keep the card fresh.
        v_person_id := (v_row->'payload'->>'target_person_id')::uuid;
        if v_person_id is not null then
          insert into public.person_observation_links (person_id, observation_id, linked_by_observation_id)
          values (v_person_id, v_obs_id, v_obs_id)
          on conflict (person_id, observation_id) do nothing;
        end if;
      end if;
    end if;
  end loop;

  inserted := v_inserted;
  deduped := (jsonb_array_length(p_rows) - v_inserted);
  return next;
end;
$$;

revoke all on function public.upsert_observations(uuid, jsonb) from public;
grant execute on function public.upsert_observations(uuid, jsonb) to anon, authenticated, service_role;$stmt_20260419900006$])
on conflict (version) do nothing;

-- from: 20260420_select_persons_page_rpc.sql
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20260420900001', 'select_persons_page_rpc', ARRAY[$stmt_20260420900001$CREATE OR REPLACE FUNCTION public.select_persons_page(
  p_user_id uuid,
  p_cursor uuid DEFAULT NULL,
  p_limit integer DEFAULT 500
)
RETURNS TABLE (id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT id FROM persons
  WHERE user_id = p_user_id
    AND (p_cursor IS NULL OR id > p_cursor)
  ORDER BY id ASC
  LIMIT LEAST(GREATEST(p_limit, 1), 2000);
$$;

REVOKE ALL ON FUNCTION public.select_persons_page(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.select_persons_page(uuid, uuid, integer) TO authenticated, anon, service_role;$stmt_20260420900001$])
on conflict (version) do nothing;

-- from: 20260420_upsert_observations_person_autolink.sql
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20260420900002', 'upsert_observations_person_autolink', ARRAY[$stmt_20260420900002$create or replace function public.upsert_observations(
  p_user_id uuid,
  p_rows jsonb
) returns table (inserted int, deduped int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted int := 0;
  v_row jsonb;
  v_kind text;
  v_person_id uuid;
  v_obs_id uuid;
  v_merged_id_text text;
  v_phone text;
  v_email text;
begin
  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_kind := v_row->>'kind';

    insert into public.observations (
      user_id, observed_at, observer, kind, evidence_pointer,
      confidence, reasoning, payload
    ) values (
      p_user_id,
      (v_row->>'observed_at')::timestamptz,
      v_row->>'observer',
      v_kind,
      v_row->>'evidence_pointer',
      (v_row->>'confidence')::numeric,
      v_row->>'reasoning',
      v_row->'payload'
    )
    on conflict (user_id, dedup_key) do nothing
    returning id into v_obs_id;

    if FOUND then
      v_inserted := v_inserted + 1;

      if v_kind = 'merge' then
        v_person_id := (v_row->'payload'->>'person_id')::uuid;

        -- Materialize the person row if it doesn't exist yet.
        insert into public.persons (id, user_id)
        values (v_person_id, p_user_id)
        on conflict (id) do nothing;

        -- Link every merged observation to this person.
        for v_merged_id_text in
          select value::text from jsonb_array_elements_text(v_row->'payload'->'merged_observation_ids')
        loop
          insert into public.person_observation_links (person_id, observation_id, linked_by_observation_id)
          values (v_person_id, v_merged_id_text::uuid, v_obs_id)
          on conflict (person_id, observation_id) do nothing;
        end loop;

        -- Also link the merge observation itself so it appears in reads.
        insert into public.person_observation_links (person_id, observation_id, linked_by_observation_id)
        values (v_person_id, v_obs_id, v_obs_id)
        on conflict (person_id, observation_id) do nothing;

      elsif v_kind = 'split' then
        v_person_id := (v_row->'payload'->>'person_id')::uuid;
        for v_merged_id_text in
          select value::text from jsonb_array_elements_text(v_row->'payload'->'split_off_observation_ids')
        loop
          delete from public.person_observation_links
           where person_id = v_person_id
             and observation_id = v_merged_id_text::uuid;
        end loop;

      elsif v_kind = 'correction' then
        -- Corrections carry a target_person_id. Link to keep the card fresh.
        v_person_id := (v_row->'payload'->>'target_person_id')::uuid;
        if v_person_id is not null then
          insert into public.person_observation_links (person_id, observation_id, linked_by_observation_id)
          values (v_person_id, v_obs_id, v_obs_id)
          on conflict (person_id, observation_id) do nothing;
        end if;

      elsif v_kind = 'person' then
        -- Stage-6 enrichment auto-link: if any prior observation of any
        -- kind shares a phone or email with this person observation's
        -- payload, link this new obs to that person. Deterministic,
        -- non-fuzzy — we only use exact-match handles the enricher
        -- copied verbatim from the existing card.
        v_person_id := null;

        -- Try phones first (cheaper; most persons have 1 phone).
        for v_phone in
          select value::text from jsonb_array_elements_text(v_row->'payload'->'phones')
        loop
          select l.person_id into v_person_id
          from public.person_observation_links l
          join public.observations o on o.id = l.observation_id
          where o.user_id = p_user_id
            and o.kind = 'person'
            and o.payload->'phones' ? v_phone
          limit 1;
          exit when v_person_id is not null;
        end loop;

        -- Fall back to emails if no phone match.
        if v_person_id is null then
          for v_email in
            select value::text from jsonb_array_elements_text(v_row->'payload'->'emails')
          loop
            select l.person_id into v_person_id
            from public.person_observation_links l
            join public.observations o on o.id = l.observation_id
            where o.user_id = p_user_id
              and o.kind = 'person'
              and o.payload->'emails' ? v_email
            limit 1;
            exit when v_person_id is not null;
          end loop;
        end if;

        -- Link only if we found an existing person. Otherwise leave
        -- the observation unlinked (caller can emit a merge later).
        if v_person_id is not null then
          insert into public.person_observation_links (person_id, observation_id, linked_by_observation_id)
          values (v_person_id, v_obs_id, v_obs_id)
          on conflict (person_id, observation_id) do nothing;
        end if;
      end if;
    end if;
  end loop;

  inserted := v_inserted;
  deduped := (jsonb_array_length(p_rows) - v_inserted);
  return next;
end;
$$;

revoke all on function public.upsert_observations(uuid, jsonb) from public;
grant execute on function public.upsert_observations(uuid, jsonb) to anon, authenticated, service_role;$stmt_20260420900002$])
on conflict (version) do nothing;

-- from: 20260420_select_enriched_persons_rpc.sql
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20260420900003', 'select_enriched_persons_rpc', ARRAY[$stmt_20260420900003$CREATE OR REPLACE FUNCTION public.select_enriched_persons(
  p_user_id uuid,
  p_cursor uuid DEFAULT NULL,
  p_limit integer DEFAULT 500
)
RETURNS TABLE (
  id uuid,
  name text,
  phones text[],
  emails text[],
  category text,
  relationship_to_me text,
  company text,
  title text,
  updated_at timestamptz,
  page_last_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(p_limit, 1), 2000);
  v_page_ids uuid[];
  v_last_id uuid;
  v_person_id uuid;
  v_row record;
  v_emitted_any boolean := false;

  v_name text;
  v_company text;
  v_title text;
  v_category text;
  v_relationship text;
  v_phones text[];
  v_emails text[];
  v_last_observed timestamptz;

  v_payload jsonb;
  v_field text;
  v_new_value jsonb;
  v_enriched boolean;
  v_item text;
BEGIN
  -- Step 1: page of persons for this user (cursor-paginated, ASC by id).
  SELECT COALESCE(array_agg(pp.pid ORDER BY pp.pid ASC), ARRAY[]::uuid[])
    INTO v_page_ids
    FROM (
      SELECT public.persons.id AS pid
        FROM public.persons
       WHERE public.persons.user_id = p_user_id
         AND (p_cursor IS NULL OR public.persons.id > p_cursor)
       ORDER BY public.persons.id ASC
       LIMIT v_limit
    ) pp;

  -- Last id in the page — signals a full page so caller can keep paging.
  -- NULL when the page is short (no more persons after this).
  IF array_length(v_page_ids, 1) = v_limit THEN
    v_last_id := v_page_ids[v_limit];
  ELSE
    v_last_id := NULL;
  END IF;

  IF array_length(v_page_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  -- Step 2: per-person fold.
  FOREACH v_person_id IN ARRAY v_page_ids
  LOOP
    v_name := NULL;
    v_company := NULL;
    v_title := NULL;
    v_category := NULL;
    v_relationship := '';
    v_phones := ARRAY[]::text[];
    v_emails := ARRAY[]::text[];
    v_last_observed := NULL;

    FOR v_row IN
      SELECT o.kind, o.observed_at, o.payload
        FROM public.observations o
        JOIN public.person_observation_links l ON l.observation_id = o.id
       WHERE o.user_id = p_user_id
         AND l.person_id = v_person_id
       ORDER BY o.observed_at ASC, o.ingested_at ASC
    LOOP
      v_payload := v_row.payload;

      IF v_row.kind = 'person' THEN
        -- name: JS `if (p.name)` — non-empty string wins.
        IF jsonb_typeof(v_payload->'name') = 'string'
           AND length(v_payload->>'name') > 0 THEN
          v_name := v_payload->>'name';
        END IF;
        -- company: JS `!== undefined && !== null`. JSONB: absent key -> skip;
        -- explicit null -> set NULL; string -> set string.
        IF (v_payload ? 'company')
           AND jsonb_typeof(v_payload->'company') IN ('string','null') THEN
          IF jsonb_typeof(v_payload->'company') = 'null' THEN
            v_company := NULL;
          ELSE
            v_company := v_payload->>'company';
          END IF;
        END IF;
        IF (v_payload ? 'title')
           AND jsonb_typeof(v_payload->'title') IN ('string','null') THEN
          IF jsonb_typeof(v_payload->'title') = 'null' THEN
            v_title := NULL;
          ELSE
            v_title := v_payload->>'title';
          END IF;
        END IF;
        IF jsonb_typeof(v_payload->'category') = 'string'
           AND length(v_payload->>'category') > 0 THEN
          v_category := v_payload->>'category';
        END IF;
        IF jsonb_typeof(v_payload->'relationship_to_me') = 'string'
           AND length(v_payload->>'relationship_to_me') > 0 THEN
          v_relationship := v_payload->>'relationship_to_me';
        END IF;
        -- phones: insertion-order dedup. Mirrors JS Set semantics.
        IF jsonb_typeof(v_payload->'phones') = 'array' THEN
          FOR v_item IN SELECT jsonb_array_elements_text(v_payload->'phones')
          LOOP
            IF v_item IS NOT NULL AND NOT (v_item = ANY(v_phones)) THEN
              v_phones := v_phones || v_item;
            END IF;
          END LOOP;
        END IF;
        IF jsonb_typeof(v_payload->'emails') = 'array' THEN
          FOR v_item IN SELECT jsonb_array_elements_text(v_payload->'emails')
          LOOP
            IF v_item IS NOT NULL AND NOT (v_item = ANY(v_emails)) THEN
              v_emails := v_emails || v_item;
            END IF;
          END LOOP;
        END IF;

      ELSIF v_row.kind = 'correction' THEN
        v_field := v_payload->>'field';
        v_new_value := v_payload->'new_value';
        IF v_field = 'name' AND jsonb_typeof(v_new_value) = 'string' THEN
          v_name := v_payload->>'new_value';
        ELSIF v_field = 'company' AND jsonb_typeof(v_new_value) IN ('string','null') THEN
          IF jsonb_typeof(v_new_value) = 'null' THEN
            v_company := NULL;
          ELSE
            v_company := v_payload->>'new_value';
          END IF;
        ELSIF v_field = 'title' AND jsonb_typeof(v_new_value) IN ('string','null') THEN
          IF jsonb_typeof(v_new_value) = 'null' THEN
            v_title := NULL;
          ELSE
            v_title := v_payload->>'new_value';
          END IF;
        ELSIF v_field = 'category' AND jsonb_typeof(v_new_value) = 'string' THEN
          v_category := v_payload->>'new_value';
        ELSIF v_field = 'relationship_to_me' AND jsonb_typeof(v_new_value) = 'string' THEN
          v_relationship := v_payload->>'new_value';
        ELSIF v_field = 'phones' AND jsonb_typeof(v_new_value) = 'array' THEN
          v_phones := ARRAY[]::text[];
          FOR v_item IN SELECT jsonb_array_elements_text(v_new_value)
          LOOP
            IF v_item IS NOT NULL AND NOT (v_item = ANY(v_phones)) THEN
              v_phones := v_phones || v_item;
            END IF;
          END LOOP;
        ELSIF v_field = 'emails' AND jsonb_typeof(v_new_value) = 'array' THEN
          v_emails := ARRAY[]::text[];
          FOR v_item IN SELECT jsonb_array_elements_text(v_new_value)
          LOOP
            IF v_item IS NOT NULL AND NOT (v_item = ANY(v_emails)) THEN
              v_emails := v_emails || v_item;
            END IF;
          END LOOP;
        END IF;
      END IF;

      IF v_last_observed IS NULL OR v_row.observed_at > v_last_observed THEN
        v_last_observed := v_row.observed_at;
      END IF;
    END LOOP;

    v_enriched := (
      (v_category IS NOT NULL AND v_category <> 'other')
      OR (v_relationship IS NOT NULL
          AND length(v_relationship) > 0
          AND v_relationship NOT LIKE 'Appears in%')
    );

    IF v_enriched THEN
      id := v_person_id;
      name := v_name;
      phones := v_phones;
      emails := v_emails;
      category := v_category;
      relationship_to_me := v_relationship;
      company := v_company;
      title := v_title;
      updated_at := v_last_observed;
      page_last_id := v_last_id;
      v_emitted_any := true;
      RETURN NEXT;
    END IF;
  END LOOP;

  -- If the page was full but every row was filtered out, we still need
  -- to surface the cursor so the caller can keep paging. Emit a sentinel
  -- row with id=NULL carrying only page_last_id. The caller filters
  -- id=NULL rows out of `persons[]` but uses page_last_id for next_cursor.
  IF NOT v_emitted_any AND v_last_id IS NOT NULL THEN
    id := NULL;
    name := NULL;
    phones := NULL;
    emails := NULL;
    category := NULL;
    relationship_to_me := NULL;
    company := NULL;
    title := NULL;
    updated_at := NULL;
    page_last_id := v_last_id;
    RETURN NEXT;
  END IF;

  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.select_enriched_persons(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.select_enriched_persons(uuid, uuid, integer) TO anon, authenticated, service_role;$stmt_20260420900003$])
on conflict (version) do nothing;

-- from: 20260421_api_keys_table_and_rpc.sql
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20260421900001', 'api_keys_table_and_rpc', ARRAY[$stmt_20260421900001$create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Reshape / create api_keys to match the spec.
-- ---------------------------------------------------------------------------

create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  key_hash text not null unique,
  prefix text not null,
  name text not null default 'agent',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

-- The silent-gap production table had: key_prefix, scopes, expires_at,
-- and a non-unique key_hash. Reshape it idempotently.

alter table public.api_keys
  alter column name set default 'agent';

-- Rename key_prefix -> prefix (preserve the 2 existing rows).
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'api_keys' and column_name = 'key_prefix'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'api_keys' and column_name = 'prefix'
  ) then
    execute 'alter table public.api_keys rename column key_prefix to prefix';
  end if;
end $$;

alter table public.api_keys
  add column if not exists prefix text,
  add column if not exists revoked_at timestamptz,
  add column if not exists last_used_at timestamptz;

-- Backfill any NULL prefixes from existing rows (shouldn't happen but safe).
update public.api_keys set prefix = left(key_hash, 12) where prefix is null;

alter table public.api_keys
  alter column prefix set not null;

-- Drop legacy columns (hard cutover, no shims).
alter table public.api_keys
  drop column if exists scopes,
  drop column if exists expires_at;

-- Ensure key_hash is globally unique.
do $$
begin
  if not exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    where t.relname = 'api_keys'
      and c.contype = 'u'
      and c.conname = 'api_keys_key_hash_key'
  ) then
    execute 'alter table public.api_keys add constraint api_keys_key_hash_key unique (key_hash)';
  end if;
end $$;

create index if not exists api_keys_user_active_idx
  on public.api_keys (user_id)
  where revoked_at is null;

-- ---------------------------------------------------------------------------
-- RLS: users manage their own keys. service_role bypasses.
-- ---------------------------------------------------------------------------

alter table public.api_keys enable row level security;

drop policy if exists "Users can view own api_keys" on public.api_keys;
drop policy if exists "users select own api_keys" on public.api_keys;
create policy "users select own api_keys" on public.api_keys
  for select using (auth.uid() = user_id);

drop policy if exists "Users can insert own api_keys" on public.api_keys;
drop policy if exists "users insert own api_keys" on public.api_keys;
create policy "users insert own api_keys" on public.api_keys
  for insert with check (auth.uid() = user_id);

drop policy if exists "Users can update own api_keys" on public.api_keys;
drop policy if exists "users update own api_keys" on public.api_keys;
create policy "users update own api_keys" on public.api_keys
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Users can delete own api_keys" on public.api_keys;

-- ---------------------------------------------------------------------------
-- validate_api_key(key_hash_input text) RETURNS uuid
--
-- Signature dictated by src/lib/api-auth.ts call site:
--     supabase.rpc("validate_api_key", { key_hash_input: hash })
--     const { data: userId } = ...
-- On match: bumps last_used_at, returns user_id. On miss / revoked:
-- returns NULL (no error). Display name + self_node_id are resolved
-- separately via get_profile_by_user_id.
-- ---------------------------------------------------------------------------

create or replace function public.validate_api_key(key_hash_input text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
begin
  update public.api_keys
    set last_used_at = now()
    where key_hash = key_hash_input
      and revoked_at is null
    returning user_id into v_user_id;

  return v_user_id;
end;
$$;

revoke all on function public.validate_api_key(text) from public;
grant execute on function public.validate_api_key(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- mint_api_key(p_user_id, p_key_hash, p_prefix, p_name) RETURNS row
--
-- Raw key + sha256 hash are generated client-side (generateApiKey in
-- src/lib/api-auth.ts). This RPC only persists.
-- ---------------------------------------------------------------------------

create or replace function public.mint_api_key(
  p_user_id uuid,
  p_key_hash text,
  p_prefix text,
  p_name text
)
returns table (id uuid, prefix text, created_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  insert into public.api_keys (user_id, key_hash, prefix, name)
  values (p_user_id, p_key_hash, p_prefix, coalesce(nullif(p_name, ''), 'agent'))
  returning api_keys.id, api_keys.prefix, api_keys.created_at;
end;
$$;

revoke all on function public.mint_api_key(uuid, text, text, text) from public;
grant execute on function public.mint_api_key(uuid, text, text, text) to authenticated, service_role;$stmt_20260421900001$])
on conflict (version) do nothing;

-- from: 20260421_capability_reports.sql
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20260421900002', 'capability_reports', ARRAY[$stmt_20260421900002$create extension if not exists pgcrypto;

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
grant execute on function public.upsert_capability_report(uuid, text, text, jsonb, jsonb, jsonb) to authenticated, service_role;$stmt_20260421900002$])
on conflict (version) do nothing;

-- from: 20260421_capability_reports_fixes.sql
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20260421900003', 'capability_reports_fixes', ARRAY[$stmt_20260421900003$create or replace function public.select_capability_reports(
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
grant execute on function public.upsert_capability_report(uuid, text, text, jsonb, jsonb, jsonb) to authenticated, service_role;$stmt_20260421900003$])
on conflict (version) do nothing;

-- from: 20260421_select_person_card_rows_rpc.sql
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20260421900004', 'select_person_card_rows_rpc', ARRAY[$stmt_20260421900004$create or replace function public.select_person_card_rows(
  p_user_id uuid,
  p_person_id uuid
)
returns setof public.observations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.persons
    where id = p_person_id and user_id = p_user_id
  ) then
    return;
  end if;

  return query
    with identity_rows as (
      select o.*
        from public.observations o
        join public.person_observation_links l on l.observation_id = o.id
       where o.user_id = p_user_id
         and l.person_id = p_person_id
         and o.kind in ('person', 'correction')
    ),
    interaction_tail as (
      select o.*
        from public.observations o
        join public.person_observation_links l on l.observation_id = o.id
       where o.user_id = p_user_id
         and l.person_id = p_person_id
         and o.kind = 'interaction'
       order by o.observed_at desc
       limit 500
    )
    select * from identity_rows
    union all
    select * from interaction_tail
    order by observed_at asc;
end;
$$;

revoke all on function public.select_person_card_rows(uuid, uuid) from public;
grant execute on function public.select_person_card_rows(uuid, uuid) to anon, authenticated, service_role;$stmt_20260421900004$])
on conflict (version) do nothing;

-- from: 20260421_meetings.sql
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20260421900005', 'meetings', ARRAY[$stmt_20260421900005$create extension if not exists pgcrypto;

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
grant execute on function public.select_upcoming_meetings(uuid, integer) to anon, authenticated, service_role;$stmt_20260421900005$])
on conflict (version) do nothing;

-- from: 20260422_self_init_rpc.sql
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20260422900001', 'self_init_rpc', ARRAY[$stmt_20260422900001$create or replace function public.resolve_self_node_id(
  p_user_id uuid,
  p_emails text[] default '{}',
  p_phones text[] default '{}'
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing text;
  v_match_id uuid;
  v_email_lc text[];
begin
  -- Short-circuit: already resolved.
  select self_node_id into v_existing
    from public.profiles
    where id = p_user_id;
  if v_existing is not null and length(v_existing) > 0 then
    return v_existing;
  end if;

  -- Lowercase the candidate emails for case-insensitive containment.
  select array_agg(lower(e)) into v_email_lc
    from unnest(coalesce(p_emails, '{}'::text[])) e
    where e is not null and length(trim(e)) > 0;

  if v_email_lc is not null and array_length(v_email_lc, 1) > 0 then
    -- Find a person linked to a `kind='person'` observation whose
    -- payload.emails (lowercased) intersects any candidate. Most-recent
    -- observation wins on tie to stabilise re-resolves after renames.
    select l.person_id into v_match_id
      from public.observations o
      join public.person_observation_links l
        on l.observation_id = o.id
      where o.user_id = p_user_id
        and o.kind = 'person'
        and exists (
          select 1
            from jsonb_array_elements_text(coalesce(o.payload->'emails', '[]'::jsonb)) e
            where lower(e) = any(v_email_lc)
        )
      order by o.observed_at desc
      limit 1;
  end if;

  -- Phone fallback — same shape, against payload.phones.
  if v_match_id is null
     and p_phones is not null
     and array_length(p_phones, 1) > 0
  then
    select l.person_id into v_match_id
      from public.observations o
      join public.person_observation_links l
        on l.observation_id = o.id
      where o.user_id = p_user_id
        and o.kind = 'person'
        and exists (
          select 1
            from jsonb_array_elements_text(coalesce(o.payload->'phones', '[]'::jsonb)) p
            where p = any(p_phones)
        )
      order by o.observed_at desc
      limit 1;
  end if;

  if v_match_id is null then
    return null;
  end if;

  update public.profiles
     set self_node_id = v_match_id::text
     where id = p_user_id;

  return v_match_id::text;
end;
$$;

revoke all on function public.resolve_self_node_id(uuid, text[], text[]) from public;
grant execute on function public.resolve_self_node_id(uuid, text[], text[])
  to anon, authenticated, service_role;$stmt_20260422900001$])
on conflict (version) do nothing;

-- from: 20260421_select_person_card_rows_rpc_v2.sql
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20260421900006', 'select_person_card_rows_rpc_v2', ARRAY[$stmt_20260421900006$create or replace function public.select_person_card_rows(
  p_user_id uuid,
  p_person_id uuid
)
returns setof public.observations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.persons
    where id = p_person_id and user_id = p_user_id
  ) then
    return;
  end if;

  return query
    with identity_rows as (
      select o.*
        from public.observations o
        join public.person_observation_links l on l.observation_id = o.id
       where o.user_id = p_user_id
         and l.person_id = p_person_id
         and o.kind in ('person', 'correction')
    ),
    interaction_tail as (
      select o.*
        from public.observations o
        join public.person_observation_links l on l.observation_id = o.id
       where o.user_id = p_user_id
         and l.person_id = p_person_id
         and o.kind = 'interaction'
       order by o.observed_at desc
       limit 50
    )
    select * from identity_rows
    union all
    select * from interaction_tail
    order by observed_at asc;
end;
$$;

revoke all on function public.select_person_card_rows(uuid, uuid) from public;
grant execute on function public.select_person_card_rows(uuid, uuid) to anon, authenticated, service_role;$stmt_20260421900006$])
on conflict (version) do nothing;

-- from: 20260421_lid_phone_bridge.sql
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20260421900007', 'lid_phone_bridge', ARRAY[$stmt_20260421900007$create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Base table.
-- ---------------------------------------------------------------------------

create table if not exists public.lid_phone_bridge (
  user_id uuid not null references auth.users(id) on delete cascade,
  lid text not null,
  phone text not null,
  last_seen timestamptz not null default now(),
  primary key (user_id, lid)
);

create index if not exists lid_phone_bridge_user_phone_idx
  on public.lid_phone_bridge (user_id, phone);

-- ---------------------------------------------------------------------------
-- RLS: users select their own rows; service_role + SECURITY DEFINER
-- RPCs handle writes.
-- ---------------------------------------------------------------------------

alter table public.lid_phone_bridge enable row level security;

drop policy if exists "users select own lid_phone_bridge" on public.lid_phone_bridge;
create policy "users select own lid_phone_bridge" on public.lid_phone_bridge
  for select using (auth.uid() = user_id);

-- No user-level INSERT/UPDATE/DELETE policy: writes funnel through
-- upsert_lid_bridge (SECURITY DEFINER); service_role bypasses RLS.

-- ---------------------------------------------------------------------------
-- upsert_lid_bridge(p_user_id uuid, p_entries jsonb) RETURNS int
--
-- Bulk upsert. `p_entries` is a jsonb array of {lid, phone, last_seen?}
-- objects. Each entry is idempotent on (user_id, lid). When last_seen is
-- provided we take the max(existing, incoming) so older rewrites don't
-- clobber a recent ping.
--
-- Returns the count of rows actually inserted or updated.
-- ---------------------------------------------------------------------------

create or replace function public.upsert_lid_bridge(
  p_user_id uuid,
  p_entries jsonb
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' then
    return 0;
  end if;

  with input as (
    select
      trim(e->>'lid') as lid,
      trim(e->>'phone') as phone,
      coalesce(
        nullif(e->>'last_seen', '')::timestamptz,
        now()
      ) as last_seen
    from jsonb_array_elements(p_entries) as e
    where e->>'lid' is not null
      and e->>'phone' is not null
      and trim(e->>'lid') <> ''
      and trim(e->>'phone') <> ''
  ),
  ins as (
    insert into public.lid_phone_bridge (user_id, lid, phone, last_seen)
    select p_user_id, lid, phone, last_seen
    from input
    on conflict (user_id, lid) do update
      set phone = excluded.phone,
          last_seen = greatest(
            public.lid_phone_bridge.last_seen,
            excluded.last_seen
          )
    returning 1
  )
  select count(*) from ins into v_count;

  return v_count;
end;
$$;

revoke all on function public.upsert_lid_bridge(uuid, jsonb) from public;
grant execute on function public.upsert_lid_bridge(uuid, jsonb) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- select_lid_phone_map(p_user_id uuid) RETURNS jsonb
--
-- Returns the full lid→phone map as a single jsonb array to bypass
-- PostgREST's 1000-row SETOF cap (bridge can exceed 10k rows easily).
-- Mirrors the select_phone_person_map pattern in the graph RPCs.
-- ---------------------------------------------------------------------------

create or replace function public.select_lid_phone_map(
  p_user_id uuid
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object('lid', lid, 'phone', phone)
      order by lid
    ),
    '[]'::jsonb
  )
  from public.lid_phone_bridge
  where user_id = p_user_id;
$$;

revoke all on function public.select_lid_phone_map(uuid) from public;
grant execute on function public.select_lid_phone_map(uuid) to anon, authenticated, service_role;$stmt_20260421900007$])
on conflict (version) do nothing;

-- from: 20260421_graph_populate_rpcs.sql
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('20260421900008', 'graph_populate_rpcs', ARRAY[$stmt_20260421900008$create or replace function public.select_graph_nodes(
  p_user_id uuid,
  p_cursor uuid default null,
  p_limit int default 1000
)
returns table (
  id uuid,
  name text,
  category text,
  company text,
  title text,
  relationship_to_me text,
  phone_count int,
  email_count int,
  first_seen timestamptz,
  last_seen timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_person_id uuid;
  v_limit int := least(greatest(p_limit, 1), 2000);
  v_row record;
  v_payload jsonb;

  v_name text;
  v_company text;
  v_title text;
  v_category text;
  v_relationship text;
  v_phones text[];
  v_emails text[];
  v_first timestamptz;
  v_last timestamptz;
  v_item text;
  v_field text;
  v_new_value jsonb;
begin
  for v_person_id in
    select public.persons.id from public.persons
     where public.persons.user_id = p_user_id
       and (p_cursor is null or public.persons.id > p_cursor)
     order by public.persons.id asc
     limit v_limit
  loop
    v_name := null;
    v_company := null;
    v_title := null;
    v_category := null;
    v_relationship := '';
    v_phones := array[]::text[];
    v_emails := array[]::text[];
    v_first := null;
    v_last := null;

    for v_row in
      select o.kind, o.observed_at, o.payload
        from public.observations o
        join public.person_observation_links l on l.observation_id = o.id
       where o.user_id = p_user_id
         and l.person_id = v_person_id
       order by o.observed_at asc, o.ingested_at asc
    loop
      v_payload := v_row.payload;

      if v_row.kind = 'person' then
        if jsonb_typeof(v_payload->'name') = 'string'
           and length(v_payload->>'name') > 0 then
          v_name := v_payload->>'name';
        end if;
        if (v_payload ? 'company')
           and jsonb_typeof(v_payload->'company') in ('string','null') then
          if jsonb_typeof(v_payload->'company') = 'null' then
            v_company := null;
          else
            v_company := v_payload->>'company';
          end if;
        end if;
        if (v_payload ? 'title')
           and jsonb_typeof(v_payload->'title') in ('string','null') then
          if jsonb_typeof(v_payload->'title') = 'null' then
            v_title := null;
          else
            v_title := v_payload->>'title';
          end if;
        end if;
        if jsonb_typeof(v_payload->'category') = 'string'
           and length(v_payload->>'category') > 0 then
          v_category := v_payload->>'category';
        end if;
        if jsonb_typeof(v_payload->'relationship_to_me') = 'string'
           and length(v_payload->>'relationship_to_me') > 0 then
          v_relationship := v_payload->>'relationship_to_me';
        end if;
        if jsonb_typeof(v_payload->'phones') = 'array' then
          for v_item in select jsonb_array_elements_text(v_payload->'phones')
          loop
            if v_item is not null and not (v_item = any(v_phones)) then
              v_phones := v_phones || v_item;
            end if;
          end loop;
        end if;
        if jsonb_typeof(v_payload->'emails') = 'array' then
          for v_item in select jsonb_array_elements_text(v_payload->'emails')
          loop
            if v_item is not null and not (v_item = any(v_emails)) then
              v_emails := v_emails || v_item;
            end if;
          end loop;
        end if;

      elsif v_row.kind = 'correction' then
        v_field := v_payload->>'field';
        v_new_value := v_payload->'new_value';
        if v_field = 'name' and jsonb_typeof(v_new_value) = 'string' then
          v_name := v_payload->>'new_value';
        elsif v_field = 'company' and jsonb_typeof(v_new_value) in ('string','null') then
          if jsonb_typeof(v_new_value) = 'null' then
            v_company := null;
          else
            v_company := v_payload->>'new_value';
          end if;
        elsif v_field = 'title' and jsonb_typeof(v_new_value) in ('string','null') then
          if jsonb_typeof(v_new_value) = 'null' then
            v_title := null;
          else
            v_title := v_payload->>'new_value';
          end if;
        elsif v_field = 'category' and jsonb_typeof(v_new_value) = 'string' then
          v_category := v_payload->>'new_value';
        elsif v_field = 'relationship_to_me' and jsonb_typeof(v_new_value) = 'string' then
          v_relationship := v_payload->>'new_value';
        elsif v_field = 'phones' and jsonb_typeof(v_new_value) = 'array' then
          v_phones := array[]::text[];
          for v_item in select jsonb_array_elements_text(v_new_value)
          loop
            if v_item is not null and not (v_item = any(v_phones)) then
              v_phones := v_phones || v_item;
            end if;
          end loop;
        elsif v_field = 'emails' and jsonb_typeof(v_new_value) = 'array' then
          v_emails := array[]::text[];
          for v_item in select jsonb_array_elements_text(v_new_value)
          loop
            if v_item is not null and not (v_item = any(v_emails)) then
              v_emails := v_emails || v_item;
            end if;
          end loop;
        end if;
      end if;

      if v_first is null or v_row.observed_at < v_first then
        v_first := v_row.observed_at;
      end if;
      if v_last is null or v_row.observed_at > v_last then
        v_last := v_row.observed_at;
      end if;
    end loop;

    id := v_person_id;
    name := v_name;
    category := v_category;
    company := v_company;
    title := v_title;
    relationship_to_me := v_relationship;
    phone_count := coalesce(array_length(v_phones, 1), 0);
    email_count := coalesce(array_length(v_emails, 1), 0);
    first_seen := v_first;
    last_seen := v_last;
    return next;
  end loop;

  return;
end;
$$;

revoke all on function public.select_graph_nodes(uuid, uuid, int) from public;
grant execute on function public.select_graph_nodes(uuid, uuid, int) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- phone -> person_id mapping for this user.
-- Used by the three edge RPCs below to resolve participant phones /
-- DM thread jids back to persons.
-- ---------------------------------------------------------------------------

-- Returns a single jsonb array (one element per phone) to bypass the
-- PostgREST SETOF cap (1000 rows by default). At 1,500+ phones this
-- cap truncates a `returns table` form.
create or replace function public.select_phone_person_map(
  p_user_id uuid
)
returns jsonb
language sql
security definer
set search_path = public, extensions
as $$
  select coalesce(
    jsonb_agg(jsonb_build_object('phone', phone, 'person_id', person_id)
              order by phone),
    '[]'::jsonb
  )
  from (
    select distinct on (phone)
      jsonb_array_elements_text(o.payload->'phones') as phone,
      l.person_id
    from public.observations o
    join public.person_observation_links l on l.observation_id = o.id
    where o.user_id = p_user_id
      and o.kind = 'person'
      and jsonb_typeof(o.payload->'phones') = 'array'
    order by phone, o.observed_at asc
  ) s
$$;

revoke all on function public.select_phone_person_map(uuid) from public;
grant execute on function public.select_phone_person_map(uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- DM edges: self-person <-> other-person.
-- Derived from whatsapp raw_events whose thread_id is a direct chat
-- (ends in @s.whatsapp.net). We pair every such thread with the person
-- whose phone matches the thread phone.
-- ---------------------------------------------------------------------------

create or replace function public.select_dm_thread_stats(
  p_user_id uuid
)
returns table (
  thread_phone text,
  msg_count bigint,
  first_at timestamptz,
  last_at timestamptz
)
language sql
security definer
set search_path = public, extensions
as $$
  -- thread_id is like "971586783040@s.whatsapp.net". Strip the
  -- @s.whatsapp.net suffix and prefix with + so it matches the phones
  -- stored on persons (which are +E164).
  select
    '+' || split_part(thread_id, '@', 1) as thread_phone,
    count(*) as msg_count,
    min(occurred_at) as first_at,
    max(occurred_at) as last_at
  from public.raw_events
  where user_id = p_user_id
    and source = 'whatsapp'
    and thread_id like '%@s.whatsapp.net'
  group by thread_id
$$;

revoke all on function public.select_dm_thread_stats(uuid) from public;
grant execute on function public.select_dm_thread_stats(uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Per group-thread: the set of phones that appeared in participant_phones
-- across the thread (bounded coverage -- many group senders are @lid-only
-- and cannot be mapped to persons in V0). Returned as one row per thread,
-- per phone. Callers fan this out to pairwise edges.
-- ---------------------------------------------------------------------------

create or replace function public.select_group_thread_phones(
  p_user_id uuid
)
returns table (
  thread_id text,
  phone text,
  last_at timestamptz,
  msg_count bigint
)
language sql
security definer
set search_path = public, extensions
as $$
  select
    re.thread_id,
    p.phone,
    max(re.occurred_at) as last_at,
    count(*) as msg_count
  from public.raw_events re
  cross join lateral unnest(re.participant_phones) as p(phone)
  where re.user_id = p_user_id
    and re.source = 'whatsapp'
    and re.thread_id like '%@g.us'
    and re.participant_phones <> array[]::text[]
  group by re.thread_id, p.phone
$$;

revoke all on function public.select_group_thread_phones(uuid) from public;
grant execute on function public.select_group_thread_phones(uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Per group-thread: LID senders appearing in participants_raw[0].jid.
-- This is the bulk of group messages in the WhatsApp LID-rollout era —
-- ~95% of group rows have `@lid`-format senders rather than phones. The
-- populate route joins these rows against lid_phone_bridge (populated
-- from claw's whatsmeow_lid_map) to resolve each LID to a phone, then
-- into a person via select_phone_person_map.
--
-- We deliberately emit LIDs as raw digits (strip '@lid') to match the
-- format stored in lid_phone_bridge.lid.
-- ---------------------------------------------------------------------------

-- Returns a single jsonb array (one element per (thread_id, lid)) to bypass
-- PostgREST's 1000-row SETOF cap. Group LID senders can easily exceed 1k
-- distinct pairs once the full history is loaded.
create or replace function public.select_group_thread_lids(
  p_user_id uuid
)
returns jsonb
language sql
security definer
set search_path = public, extensions
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'thread_id', thread_id,
        'lid', lid,
        'last_at', last_at,
        'msg_count', msg_count
      )
    ),
    '[]'::jsonb
  )
  from (
    select
      re.thread_id,
      split_part(re.participants_raw->0->>'jid', '@', 1) as lid,
      max(re.occurred_at) as last_at,
      count(*) as msg_count
    from public.raw_events re
    where re.user_id = p_user_id
      and re.source = 'whatsapp'
      and re.thread_id like '%@g.us'
      and re.participants_raw->0->>'jid' like '%@lid'
    group by re.thread_id, split_part(re.participants_raw->0->>'jid', '@', 1)
  ) s
$$;

revoke all on function public.select_group_thread_lids(uuid) from public;
grant execute on function public.select_group_thread_lids(uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Email interaction counts per (other-)person.
-- Each interaction observation links to exactly one non-self person; the
-- edge is self<->person. We aggregate message_count / first_at / last_at
-- per linked person.
-- ---------------------------------------------------------------------------

create or replace function public.select_email_interactions(
  p_user_id uuid
)
returns table (
  person_id uuid,
  msg_count bigint,
  first_at timestamptz,
  last_at timestamptz
)
language sql
security definer
set search_path = public, extensions
as $$
  select
    l.person_id,
    count(*) as msg_count,
    min(o.observed_at) as first_at,
    max(o.observed_at) as last_at
  from public.observations o
  join public.person_observation_links l on l.observation_id = o.id
  where o.user_id = p_user_id
    and o.kind = 'interaction'
    and o.payload->>'channel' = 'email'
  group by l.person_id
$$;

revoke all on function public.select_email_interactions(uuid) from public;
grant execute on function public.select_email_interactions(uuid) to anon, authenticated, service_role;$stmt_20260421900008$])
on conflict (version) do nothing;


-- ---------------------------------------------------------------------------
-- 2. Drop dead RPCs.
-- ---------------------------------------------------------------------------

-- record_merge_audit: superseded by record_merge_audit_rpc (20260417_record_merge_audit_rpc.sql).
-- Live signature captured from pg_proc on 2026-04-21.
drop function if exists public.record_merge_audit(
  uuid, text, text[], text, numeric, text, jsonb
);

-- select_person_observations: superseded by select_observations
-- (20260419_select_observations_rpc.sql). No caller remains.
drop function if exists public.select_person_observations(uuid, uuid);

-- select_persons_page: superseded by select_enriched_persons
-- (20260420_select_enriched_persons_rpc.sql). No caller remains.
drop function if exists public.select_persons_page(uuid, uuid, integer);


-- ---------------------------------------------------------------------------
-- 3. Clean audit residue.
-- ---------------------------------------------------------------------------

-- Audit-probe meetings from capability-audit runs.
delete from public.meetings
  where meeting_id like 'audit-%'
     or meeting_id like 'audit_%';

-- Orphan observations for the founder account (dbb398c2-...): kind person/merge
-- rows that never got linked to a person row because the auto-link pass failed
-- partway through or the observation pre-dated the person_observation_links
-- table. Delete only those that are still unlinked.
delete from public.observations o
  where o.user_id = 'dbb398c2-1eff-4eee-ae10-bad13be5fda7'
    and o.kind in ('person', 'merge')
    and not exists (
      select 1 from public.person_observation_links l
      where l.observation_id = o.id
    );
