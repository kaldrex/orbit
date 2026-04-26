create or replace function public.select_person_card_rows(
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
    ),
    note_tail as (
      select o.*
        from public.observations o
        join public.person_observation_links l on l.observation_id = o.id
       where o.user_id = p_user_id
         and l.person_id = p_person_id
         and o.kind = 'note'
       order by o.observed_at desc
       limit 50
    )
    select * from identity_rows
    union all
    select * from interaction_tail
    union all
    select * from note_tail
    order by observed_at asc;
end;
$$;

revoke all on function public.select_person_card_rows(uuid, uuid) from public;
grant execute on function public.select_person_card_rows(uuid, uuid)
  to anon, authenticated, service_role;
