create or replace function public.fold_person_cards(
  p_user_id uuid,
  p_cursor uuid default null,
  p_limit integer default 200000
) returns table (
  id uuid,
  name text,
  phones text[],
  emails text[],
  category text,
  relationship_to_me text,
  company text,
  title text,
  relationship_strength text,
  updated_at timestamptz,
  last_activity jsonb,
  activity_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_person_id uuid;
  v_row record;
  v_payload jsonb;
  v_field text;
  v_value jsonb;
  v_item text;
  v_activity_at timestamptz;
  v_activity_payload jsonb;
  v_limit int := least(greatest(coalesce(p_limit, 200000), 1), 200000);
begin
  for v_person_id in
    select public.persons.id
      from public.persons
     where public.persons.user_id = p_user_id
       and (p_cursor is null or public.persons.id > p_cursor)
     order by public.persons.id asc
     limit v_limit
  loop
    id := v_person_id;
    name := null; company := null; title := null; category := null;
    relationship_to_me := ''; relationship_strength := null;
    phones := array[]::text[]; emails := array[]::text[];
    updated_at := null; last_activity := null; activity_count := 0;
    v_activity_at := null; v_activity_payload := null;

    for v_row in
      select o.kind, o.observed_at, o.ingested_at, o.payload
        from public.observations o
        join public.person_observation_links l on l.observation_id = o.id
       where o.user_id = p_user_id and l.person_id = v_person_id
       order by o.observed_at asc, o.ingested_at asc
    loop
      v_payload := v_row.payload;
      if v_row.kind = 'person' then
        if jsonb_typeof(v_payload->'name') = 'string' and length(v_payload->>'name') > 0 then name := v_payload->>'name'; end if;
        if (v_payload ? 'company') and jsonb_typeof(v_payload->'company') in ('string','null') then company := nullif(v_payload->>'company', ''); end if;
        if (v_payload ? 'title') and jsonb_typeof(v_payload->'title') in ('string','null') then title := nullif(v_payload->>'title', ''); end if;
        if jsonb_typeof(v_payload->'category') = 'string' and length(v_payload->>'category') > 0 then category := v_payload->>'category'; end if;
        if jsonb_typeof(v_payload->'relationship_to_me') = 'string' and length(v_payload->>'relationship_to_me') > 0 then relationship_to_me := v_payload->>'relationship_to_me'; end if;
        if jsonb_typeof(v_payload->'phones') = 'array' then
          for v_item in select jsonb_array_elements_text(v_payload->'phones') loop
            if v_item is not null and not (v_item = any(phones)) then phones := phones || v_item; end if;
          end loop;
        end if;
        if jsonb_typeof(v_payload->'emails') = 'array' then
          for v_item in select jsonb_array_elements_text(v_payload->'emails') loop
            if v_item is not null and not (v_item = any(emails)) then emails := emails || v_item; end if;
          end loop;
        end if;
      elsif v_row.kind = 'correction' then
        v_field := v_payload->>'field';
        v_value := v_payload->'new_value';
        if v_field = 'name' and jsonb_typeof(v_value) = 'string' then name := v_payload->>'new_value';
        elsif v_field = 'company' and jsonb_typeof(v_value) in ('string','null') then company := nullif(v_payload->>'new_value', '');
        elsif v_field = 'title' and jsonb_typeof(v_value) in ('string','null') then title := nullif(v_payload->>'new_value', '');
        elsif v_field = 'category' and jsonb_typeof(v_value) = 'string' then category := v_payload->>'new_value';
        elsif v_field = 'relationship_to_me' and jsonb_typeof(v_value) = 'string' then relationship_to_me := v_payload->>'new_value';
        elsif v_field = 'relationship_strength' and jsonb_typeof(v_value) in ('string','null') then relationship_strength := nullif(v_payload->>'new_value', '');
        elsif v_field = 'phones' and jsonb_typeof(v_value) = 'array' then
          phones := array[]::text[];
          for v_item in select jsonb_array_elements_text(v_value) loop
            if v_item is not null and not (v_item = any(phones)) then phones := phones || v_item; end if;
          end loop;
        elsif v_field = 'emails' and jsonb_typeof(v_value) = 'array' then
          emails := array[]::text[];
          for v_item in select jsonb_array_elements_text(v_value) loop
            if v_item is not null and not (v_item = any(emails)) then emails := emails || v_item; end if;
          end loop;
        end if;
      elsif v_row.kind = 'interaction' then
        activity_count := activity_count + 1;
        if v_activity_at is null or v_row.observed_at >= v_activity_at then
          v_activity_at := v_row.observed_at;
          v_activity_payload := v_payload;
        end if;
      end if;

      if updated_at is null or v_row.observed_at > updated_at then updated_at := v_row.observed_at; end if;
    end loop;

    if v_activity_at is not null then
      last_activity := jsonb_build_object(
        'type', coalesce(v_activity_payload->>'activity_type', v_activity_payload->>'channel', 'interaction'),
        'title', coalesce(v_activity_payload->>'title', v_activity_payload->>'summary'),
        'occurred_at', v_activity_at,
        'days_ago', greatest(0, floor(extract(epoch from (now() - v_activity_at)) / 86400)::int)
      );
    end if;
    return next;
  end loop;
end;
$$;

revoke all on function public.fold_person_cards(uuid, uuid, integer) from public;
grant execute on function public.fold_person_cards(uuid, uuid, integer)
  to anon, authenticated, service_role;
