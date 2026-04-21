-- Single-source merge: accept kind:"merge" with merged_observation_ids of
-- length >= 1 (previously >= 2 enforced only client-side in the Zod schema).
--
-- Why:
--   The AddContactDialog and any per-channel observer that has only one
--   source for a human need to materialize a person from a single obs.
--   Prior callers used the `[id, id]` duplicate workaround (tracked in
--   memory/project_tracked_debt_2026_04_20.md item 3) which relied on the
--   person_observation_links PK's ON CONFLICT DO NOTHING to dedupe.
--
-- What this migration changes:
--   1. Replaces upsert_observations with a version that returns
--      `inserted_ids uuid[]` alongside the prior `(inserted, deduped)`
--      counts. Callers that need the freshly-inserted observation id (e.g.
--      to follow up with a merge obs) can now read it from the response
--      instead of re-querying.
--   2. Adds an explicit guard `jsonb_array_length(merged_observation_ids)
--      >= 1` inside the merge branch and raises a readable exception if
--      violated. This keeps the server as the canonical enforcer; the Zod
--      schema .min(1) is advisory / UX.
--   3. No behavioural change for kind != "merge".

-- Must drop because we're changing the return-table shape (adding
-- inserted_ids uuid[]). CREATE OR REPLACE FUNCTION can't alter the
-- output columns of a table-returning function.
drop function if exists public.upsert_observations(uuid, jsonb);

create function public.upsert_observations(
  p_user_id uuid,
  p_rows jsonb
) returns table (inserted int, deduped int, inserted_ids uuid[])
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted int := 0;
  v_inserted_ids uuid[] := array[]::uuid[];
  v_row jsonb;
  v_kind text;
  v_person_id uuid;
  v_obs_id uuid;
  v_merged_id_text text;
  v_phone text;
  v_email text;
  v_merged_len int;
begin
  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_kind := v_row->>'kind';

    -- Server-side enforcement of the relaxed merge arity. We accept
    -- length >= 1; a single-ID merge materializes the person from one
    -- source observation (the canonical single-source path).
    if v_kind = 'merge' then
      v_merged_len := coalesce(
        jsonb_array_length(v_row->'payload'->'merged_observation_ids'),
        0
      );
      if v_merged_len < 1 then
        raise exception 'merge requires >= 1 merged_observation_ids (got %)', v_merged_len
          using errcode = '22023';
      end if;
    end if;

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
      v_inserted_ids := array_append(v_inserted_ids, v_obs_id);

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
        -- non-fuzzy — exact-match handles only.
        v_person_id := null;

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
  inserted_ids := v_inserted_ids;
  return next;
end;
$$;

revoke all on function public.upsert_observations(uuid, jsonb) from public;
grant execute on function public.upsert_observations(uuid, jsonb) to anon, authenticated, service_role;
