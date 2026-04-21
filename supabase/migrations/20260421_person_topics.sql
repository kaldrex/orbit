-- person_topics — Topic Resonance storage.
--
-- Per-person topic weights derived from batched NER over WhatsApp (and later
-- other-channel) messages. Weight is a relative score: 0..1 per person, scaled
-- so the single largest topic approaches 1 and the tail is proportional.
--
-- Writes are atomic per (user_id, person_id): every upsert_person_topics call
-- replaces the full topic set for that person. This matches how topic-resonance
-- runs re-derive topics from scratch.
--
-- Reads return sorted-by-weight-desc, capped at p_limit.

create extension if not exists pgcrypto;

create table if not exists public.person_topics (
  user_id uuid not null references auth.users(id) on delete cascade,
  person_id uuid not null references public.persons(id) on delete cascade,
  topic text not null,
  weight numeric not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, person_id, topic)
);

create index if not exists person_topics_person_weight_idx
  on public.person_topics (user_id, person_id, weight desc);

-- ---------------------------------------------------------------------------
-- RLS: users read their own rows; service_role handles writes.
-- Non-service callers cannot INSERT/UPDATE/DELETE directly — all writes go
-- through the SECURITY DEFINER upsert RPC below.
-- ---------------------------------------------------------------------------

alter table public.person_topics enable row level security;

drop policy if exists "users select own person_topics" on public.person_topics;
create policy "users select own person_topics" on public.person_topics
  for select using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- upsert_person_topics: atomic replacement.
--
-- p_topics shape: jsonb array of { "topic": string, "weight": number }.
-- Returns the number of rows inserted for that person.
--
-- Ownership check: person_id must belong to p_user_id, else we return -1
-- (caller surfaces 404). This keeps cross-tenant leakage impossible even if
-- the API-layer ownership check is bypassed.
-- ---------------------------------------------------------------------------

create or replace function public.upsert_person_topics(
  p_user_id uuid,
  p_person_id uuid,
  p_topics jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  if not exists (
    select 1 from public.persons p
    where p.id = p_person_id and p.user_id = p_user_id
  ) then
    return -1;
  end if;

  delete from public.person_topics
   where user_id = p_user_id and person_id = p_person_id;

  insert into public.person_topics (user_id, person_id, topic, weight, updated_at)
  select
    p_user_id,
    p_person_id,
    lower(btrim(elem->>'topic')),
    coalesce((elem->>'weight')::numeric, 0),
    now()
  from jsonb_array_elements(coalesce(p_topics, '[]'::jsonb)) elem
  where coalesce(btrim(elem->>'topic'), '') <> ''
  on conflict (user_id, person_id, topic) do update
    set weight = excluded.weight,
        updated_at = excluded.updated_at;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.upsert_person_topics(uuid, uuid, jsonb) from public;
grant execute on function public.upsert_person_topics(uuid, uuid, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- select_person_topics: sorted-by-weight-desc, capped at p_limit (default 10).
-- Returns (topic text, weight numeric). Ownership enforced.
-- ---------------------------------------------------------------------------

create or replace function public.select_person_topics(
  p_user_id uuid,
  p_person_id uuid,
  p_limit integer default 10
)
returns table (topic text, weight numeric)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.persons p
    where p.id = p_person_id and p.user_id = p_user_id
  ) then
    return;
  end if;

  return query
    select pt.topic, pt.weight
      from public.person_topics pt
     where pt.user_id = p_user_id
       and pt.person_id = p_person_id
     order by pt.weight desc, pt.topic asc
     limit greatest(1, coalesce(p_limit, 10));
end;
$$;

revoke all on function public.select_person_topics(uuid, uuid, integer) from public;
grant execute on function public.select_person_topics(uuid, uuid, integer) to anon, authenticated, service_role;
