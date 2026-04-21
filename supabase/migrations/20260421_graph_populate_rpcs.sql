-- RPCs backing POST /api/v1/graph/populate.
--
-- The populate route reads Postgres, projects nodes + edges, and MERGEs
-- them into Neo4j server-side. Neo4j is a projection; Postgres is the
-- source of truth. Three RPCs feed the projection:
--
--   select_graph_nodes(p_user_id) -- all persons with card-rolled fields
--   select_graph_dm_edges(p_user_id) -- self-person <-> other-person
--                                        WhatsApp DM totals
--   select_graph_group_edges(p_user_id) -- pairwise person <-> person
--                                           edges derived from shared
--                                           @g.us thread_ids where we
--                                           can map participant_phones
--                                           back to persons
--   select_graph_email_edges(p_user_id) -- self-person <-> other-person
--                                           Gmail interaction totals
--
-- All RPCs are SECURITY DEFINER + take p_user_id explicitly so the
-- route (using ANON key) can bypass RLS. Mirrors the pattern established
-- by select_enriched_persons / select_person_card_rows.
--
-- Node card-roll mirrors select_enriched_persons's fold (see comments
-- there). We emit ALL persons here -- the graph wants every node, even
-- category='other' ones.

-- ---------------------------------------------------------------------------
-- select_graph_nodes(p_user_id) -> rows of (id, name, category, company,
--   title, relationship_to_me, phone_count, email_count, first_seen, last_seen)
-- ---------------------------------------------------------------------------

create or replace function public.select_graph_nodes(
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
grant execute on function public.select_email_interactions(uuid) to anon, authenticated, service_role;
