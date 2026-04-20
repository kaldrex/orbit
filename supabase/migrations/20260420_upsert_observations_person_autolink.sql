-- Auto-link kind:"person" enrichment observations to the existing person
-- whose prior observations share at least one phone or email.
--
-- Stage 6 (orbit-enricher) emits new kind:"person" observations carrying the
-- real category, relationship_to_me, company, title for each skeleton card.
-- The enricher copies phones/emails verbatim from the existing card, so a
-- prior observation tied to that person will always have overlapping
-- handles. We use that overlap to deterministically link the new obs
-- to the right person — no heuristic fuzzy-matching.
--
-- Non-person kinds retain their existing linking behaviour. Person
-- observations that don't overlap any prior obs are inserted without a
-- link (same as before this migration — caller must link explicitly).

create or replace function public.upsert_observations(
  p_user_id uuid,
  p_rows jsonb
) returns table (inserted int, deduped int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted int := 0;
  v_row jsonb;
  v_kind text;
  v_person_id uuid;
  v_obs_id uuid;
  v_merged_id_text text;
  v_phone text;
  v_email text;
begin
  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_kind := v_row->>'kind';

    insert into public.observations (
      user_id, observed_at, observer, kind, evidence_pointer,
      confidence, reasoning, payload
    ) values (
      p_user_id,
      (v_row->>'observed_at')::timestamptz,
      v_row->>'observer',
      v_kind,
      v_row->>'evidence_pointer',
      (v_row->>'confidence')::numeric,
      v_row->>'reasoning',
      v_row->'payload'
    )
    on conflict (user_id, dedup_key) do nothing
    returning id into v_obs_id;

    if FOUND then
      v_inserted := v_inserted + 1;

      if v_kind = 'merge' then
        v_person_id := (v_row->'payload'->>'person_id')::uuid;

        -- Materialize the person row if it doesn't exist yet.
        insert into public.persons (id, user_id)
        values (v_person_id, p_user_id)
        on conflict (id) do nothing;

        -- Link every merged observation to this person.
        for v_merged_id_text in
          select value::text from jsonb_array_elements_text(v_row->'payload'->'merged_observation_ids')
        loop
          insert into public.person_observation_links (person_id, observation_id, linked_by_observation_id)
          values (v_person_id, v_merged_id_text::uuid, v_obs_id)
          on conflict (person_id, observation_id) do nothing;
        end loop;

        -- Also link the merge observation itself so it appears in reads.
        insert into public.person_observation_links (person_id, observation_id, linked_by_observation_id)
        values (v_person_id, v_obs_id, v_obs_id)
        on conflict (person_id, observation_id) do nothing;

      elsif v_kind = 'split' then
        v_person_id := (v_row->'payload'->>'person_id')::uuid;
        for v_merged_id_text in
          select value::text from jsonb_array_elements_text(v_row->'payload'->'split_off_observation_ids')
        loop
          delete from public.person_observation_links
           where person_id = v_person_id
             and observation_id = v_merged_id_text::uuid;
        end loop;

      elsif v_kind = 'correction' then
        -- Corrections carry a target_person_id. Link to keep the card fresh.
        v_person_id := (v_row->'payload'->>'target_person_id')::uuid;
        if v_person_id is not null then
          insert into public.person_observation_links (person_id, observation_id, linked_by_observation_id)
          values (v_person_id, v_obs_id, v_obs_id)
          on conflict (person_id, observation_id) do nothing;
        end if;

      elsif v_kind = 'person' then
        -- Stage-6 enrichment auto-link: if any prior observation of any
        -- kind shares a phone or email with this person observation's
        -- payload, link this new obs to that person. Deterministic,
        -- non-fuzzy — we only use exact-match handles the enricher
        -- copied verbatim from the existing card.
        v_person_id := null;

        -- Try phones first (cheaper; most persons have 1 phone).
        for v_phone in
          select value::text from jsonb_array_elements_text(v_row->'payload'->'phones')
        loop
          select l.person_id into v_person_id
          from public.person_observation_links l
          join public.observations o on o.id = l.observation_id
          where o.user_id = p_user_id
            and o.kind = 'person'
            and o.payload->'phones' ? v_phone
          limit 1;
          exit when v_person_id is not null;
        end loop;

        -- Fall back to emails if no phone match.
        if v_person_id is null then
          for v_email in
            select value::text from jsonb_array_elements_text(v_row->'payload'->'emails')
          loop
            select l.person_id into v_person_id
            from public.person_observation_links l
            join public.observations o on o.id = l.observation_id
            where o.user_id = p_user_id
              and o.kind = 'person'
              and o.payload->'emails' ? v_email
            limit 1;
            exit when v_person_id is not null;
          end loop;
        end if;

        -- Link only if we found an existing person. Otherwise leave
        -- the observation unlinked (caller can emit a merge later).
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
  return next;
end;
$$;

revoke all on function public.upsert_observations(uuid, jsonb) from public;
grant execute on function public.upsert_observations(uuid, jsonb) to anon, authenticated, service_role;
