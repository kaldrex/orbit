-- Read all observations linked to a specific person.
--
-- Used by GET /api/v1/person/:id/card to gather the basket rows the
-- assembler folds into a card. Joins observations to the link table
-- populated by the resolver.
--
-- Ordered ascending by observed_at so the assembler can do a single
-- left-to-right fold (latest-wins; corrections override).
--
-- SECURITY DEFINER with caller-match guard: returns empty set if the
-- person doesn't belong to p_user_id.

create or replace function public.select_person_observations(
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
grant execute on function public.select_person_observations(uuid, uuid) to anon, authenticated, service_role;
