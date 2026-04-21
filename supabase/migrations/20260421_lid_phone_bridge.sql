-- WhatsApp LID ↔ phone bridge.
--
-- WhatsApp is in the middle of a rollout where group-message senders are
-- identified by opaque `@lid` numeric ids (privacy hiding the phone).
-- whatsmeow's local session.db on claw maintains a mapping (`whatsmeow_lid_map`:
-- lid TEXT PRIMARY KEY, pn TEXT UNIQUE) of LID → phone that we can project
-- into Postgres so the graph populate RPCs can resolve group senders back
-- to persons.
--
-- House rules:
--   * `observations` remains the source of truth for identity. This bridge
--     is a projection / cache — same shape as persons, not an observation-
--     kind. Populated via the API (never direct DB writes).
--   * One row per (user_id, lid). LIDs are globally unique in whatsmeow,
--     but the primary key is compound so multiple founders can coexist.
--   * Phones are stored as raw digits (no '+') to match what wacli's
--     session.db ships; callers normalize to E.164 on read if needed.
--   * RLS is on: users read their own rows; service_role + SECURITY
--     DEFINER RPCs handle writes. The API route never forwards user
--     JWTs — it auths via API key, resolves user_id, and calls the RPC.

create extension if not exists pgcrypto;

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
grant execute on function public.select_lid_phone_map(uuid) to anon, authenticated, service_role;
