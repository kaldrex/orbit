-- Reduce the interaction tail from 500 → 50 in select_person_card_rows.
-- Card UI only renders 20 interactions; pulling 500 was 10× the work.
-- At the 1.6–2.2s per /card call the user observed, the linear scan of
-- (6.7k observations for Umayr) was dominating.
--
-- Card contract is unchanged (name/category/… + interactions[].slice(-20)
-- in the assembler still returns the same output). Rollback: re-run the
-- original 20260421_select_person_card_rows_rpc.sql.

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
    )
    select * from identity_rows
    union all
    select * from interaction_tail
    order by observed_at asc;
end;
$$;

revoke all on function public.select_person_card_rows(uuid, uuid) from public;
grant execute on function public.select_person_card_rows(uuid, uuid) to anon, authenticated, service_role;
