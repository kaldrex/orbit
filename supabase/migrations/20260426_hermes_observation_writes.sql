alter table public.observations
  drop constraint if exists observations_kind_check;

alter table public.observations
  add constraint observations_kind_check
  check (kind in ('interaction','note','person','correction','merge','split'));

create or replace function public.upsert_observations(
  p_user_id uuid,
  p_rows jsonb
) returns table (inserted int, deduped int, inserted_ids uuid[])
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted int := 0;
  v_ids uuid[] := ARRAY[]::uuid[];
  v_row jsonb;
  v_kind text;
  v_person_id uuid;
  v_obs_id uuid;
  v_text text;
begin
  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_kind := v_row->>'kind';
    insert into public.observations (
      user_id, observed_at, observer, kind, evidence_pointer,
      confidence, reasoning, payload
    ) values (
      p_user_id, (v_row->>'observed_at')::timestamptz, v_row->>'observer',
      v_kind, v_row->>'evidence_pointer', (v_row->>'confidence')::numeric,
      v_row->>'reasoning', v_row->'payload'
    )
    on conflict (user_id, dedup_key) do nothing
    returning id into v_obs_id;

    if FOUND then
      v_inserted := v_inserted + 1;
      v_ids := v_ids || v_obs_id;

      if v_kind = 'merge' then
        v_person_id := (v_row->'payload'->>'person_id')::uuid;
        insert into public.persons (id, user_id)
        values (v_person_id, p_user_id)
        on conflict (id) do nothing;
        for v_text in
          select value::text from jsonb_array_elements_text(v_row->'payload'->'merged_observation_ids')
        loop
          insert into public.person_observation_links (person_id, observation_id, linked_by_observation_id)
          values (v_person_id, v_text::uuid, v_obs_id)
          on conflict (person_id, observation_id) do nothing;
        end loop;
        insert into public.person_observation_links (person_id, observation_id, linked_by_observation_id)
        values (v_person_id, v_obs_id, v_obs_id)
        on conflict (person_id, observation_id) do nothing;

      elsif v_kind = 'split' then
        v_person_id := (v_row->'payload'->>'person_id')::uuid;
        for v_text in
          select value::text from jsonb_array_elements_text(v_row->'payload'->'split_off_observation_ids')
        loop
          delete from public.person_observation_links
           where person_id = v_person_id and observation_id = v_text::uuid;
        end loop;

      elsif v_kind in ('correction', 'interaction', 'note') then
        v_person_id := (v_row->'payload'->>'target_person_id')::uuid;
        if v_person_id is not null then
          insert into public.person_observation_links (person_id, observation_id, linked_by_observation_id)
          values (v_person_id, v_obs_id, v_obs_id)
          on conflict (person_id, observation_id) do nothing;
        end if;

      elsif v_kind = 'person' then
        select l.person_id into v_person_id
          from public.person_observation_links l
          join public.observations o on o.id = l.observation_id
         where o.user_id = p_user_id
           and o.kind = 'person'
           and (
             exists (
               select 1 from jsonb_array_elements_text(coalesce(v_row->'payload'->'phones', '[]'::jsonb)) p
               where o.payload->'phones' ? p.value
             )
             or exists (
               select 1 from jsonb_array_elements_text(coalesce(v_row->'payload'->'emails', '[]'::jsonb)) e
               where o.payload->'emails' ? e.value
             )
           )
         limit 1;
        if v_person_id is not null then
          insert into public.person_observation_links (person_id, observation_id, linked_by_observation_id)
          values (v_person_id, v_obs_id, v_obs_id)
          on conflict (person_id, observation_id) do nothing;
        end if;
      end if;
    end if;
  end loop;

  inserted := v_inserted;
  deduped := (jsonb_array_length(p_rows) - v_inserted);
  inserted_ids := v_ids;
  return next;
end;
$$;

revoke all on function public.upsert_observations(uuid, jsonb) from public;
grant execute on function public.upsert_observations(uuid, jsonb)
  to anon, authenticated, service_role;
