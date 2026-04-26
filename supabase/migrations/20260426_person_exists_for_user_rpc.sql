create or replace function public.person_exists_for_user(
  p_user_id uuid,
  p_person_id uuid
) returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.persons p
     where p.id = p_person_id
       and p.user_id = p_user_id
  ) or exists (
    select 1
      from public.person_observation_links l
      join public.observations o on o.id = l.observation_id
     where l.person_id = p_person_id
       and o.user_id = p_user_id
  );
$$;

revoke all on function public.person_exists_for_user(uuid, uuid) from public;
grant execute on function public.person_exists_for_user(uuid, uuid)
  to anon, authenticated, service_role;
