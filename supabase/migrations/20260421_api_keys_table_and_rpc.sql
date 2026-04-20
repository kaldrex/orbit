-- Agent API keys + validation/mint RPCs.
--
-- api-auth.ts calls supabase.rpc("validate_api_key", { key_hash_input })
-- and consumes `data` as a scalar uuid. It separately calls
-- get_profile_by_user_id(uid) for display_name/self_node_id. So
-- validate_api_key returns a bare uuid (or NULL) to match that contract
-- — not the composite row shape described in the Phase 0 spec.
--
-- mint_api_key is new: the raw key + sha256 hash are generated in
-- generateApiKey() (src/lib/api-auth.ts), this RPC just persists.
--
-- Hard cutover: drops legacy columns (scopes, expires_at, key_prefix)
-- from the silent-gap table that existed in prod without a migration.

create extension if not exists pgcrypto;

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
grant execute on function public.mint_api_key(uuid, text, text, text) to authenticated, service_role;
