-- select_person_card_rows — card-assembler-optimized view over
-- observations for one person. Returns all identity-bearing rows
-- (person + correction) plus the latest 500 interactions, in the
-- ascending order the card-assembler expects.
--
-- Why: Supabase/PostgREST caps SETOF RPC responses at ~1000 rows. A
-- person with thousands of interactions (Umayr has 6.7k post-Phase-1)
-- blows past that cap and identity rows get truncated out, yielding a
-- card with null name/category/etc. This RPC guarantees all identity
-- rows are preserved and only the interaction tail is trimmed —
-- card-assembler slices to 20 anyway, so no user-visible loss.
--
-- merge/split rows are intentionally omitted — they affect *which*
-- observations link to the person, not the card content itself
-- (card-assembler already no-ops on kind='merge'/'split').

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
       limit 500
    )
    select * from identity_rows
    union all
    select * from interaction_tail
    order by observed_at asc;
end;
$$;

revoke all on function public.select_person_card_rows(uuid, uuid) from public;
grant execute on function public.select_person_card_rows(uuid, uuid) to anon, authenticated, service_role;
