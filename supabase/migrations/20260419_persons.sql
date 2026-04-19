-- Emergent person records + the link table the resolver writes.
--
-- A person is a thin anchor — just an id and an owner. All the
-- interesting content (name, phones, emails, category, etc.) lives in
-- kind:'person' observations linked via person_observation_links.
--
-- Resolver workflow:
--   1. Scan basket for deterministic merges (phone/email/LID match).
--   2. For each merged bucket, insert into persons, emit kind:'merge'
--      observation, and populate person_observation_links.
--   3. Card endpoint reads links to find all observations for a person
--      and calls assembleCard(observations, personId).
--
-- Random UUIDs (not deterministic) by design — see plan decision C:
-- deterministic UUIDs don't survive merge/split reality.

create table if not exists public.persons (
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
  );
