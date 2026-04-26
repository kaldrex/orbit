drop function if exists public.select_enriched_persons(uuid, uuid, integer);
drop function if exists public.search_persons(uuid, text, text, text, integer);

create or replace function public.select_enriched_persons(
  p_user_id uuid,
  p_cursor uuid default null,
  p_limit integer default 500
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
  activity_count integer,
  page_last_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 500), 1), 2000);
  v_page_ids uuid[];
  v_last_id uuid;
  v_row record;
  v_any boolean := false;
begin
  select coalesce(array_agg(p.id order by p.id), array[]::uuid[]) into v_page_ids
    from (
      select public.persons.id
        from public.persons
       where public.persons.user_id = p_user_id
         and (p_cursor is null or public.persons.id > p_cursor)
       order by public.persons.id asc
       limit v_limit
    ) p;

  if array_length(v_page_ids, 1) is null then return; end if;
  if array_length(v_page_ids, 1) = v_limit then v_last_id := v_page_ids[v_limit]; end if;

  for v_row in
    select * from public.fold_person_cards(p_user_id, p_cursor, v_limit) c
     where (c.category is not null and c.category <> 'other')
        or (c.relationship_to_me is not null
            and length(c.relationship_to_me) > 0
            and c.relationship_to_me not like 'Appears in%')
     order by c.id asc
  loop
    id := v_row.id; name := v_row.name; phones := v_row.phones; emails := v_row.emails;
    category := v_row.category; relationship_to_me := v_row.relationship_to_me;
    company := v_row.company; title := v_row.title;
    relationship_strength := v_row.relationship_strength;
    updated_at := v_row.updated_at; last_activity := v_row.last_activity;
    activity_count := v_row.activity_count; page_last_id := v_last_id;
    v_any := true;
    return next;
  end loop;

  if not v_any and v_last_id is not null then
    id := null; name := null; phones := null; emails := null; category := null;
    relationship_to_me := null; company := null; title := null;
    relationship_strength := null; updated_at := null; last_activity := null;
    activity_count := 0; page_last_id := v_last_id;
    return next;
  end if;
end;
$$;

create or replace function public.search_persons(
  p_user_id uuid,
  p_phone text default null,
  p_email text default null,
  p_name text default null,
  p_limit integer default 10
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
language sql
security definer
set search_path = public, pg_temp
as $$
  select c.id, c.name, c.phones, c.emails, c.category, c.relationship_to_me,
         c.company, c.title, c.relationship_strength, c.updated_at,
         c.last_activity, c.activity_count
    from public.fold_person_cards(p_user_id, null, 200000) c
   where (p_phone is not null and c.phones @> array[p_phone]::text[])
      or (p_email is not null and exists (
           select 1 from unnest(c.emails) e where lower(e) = lower(p_email)
         ))
      or (p_name is not null and c.name ilike ('%' || p_name || '%'))
   order by c.name nulls last, c.id
   limit least(greatest(coalesce(p_limit, 10), 1), 50);
$$;

revoke all on function public.select_enriched_persons(uuid, uuid, integer) from public;
revoke all on function public.search_persons(uuid, text, text, text, integer) from public;
grant execute on function public.select_enriched_persons(uuid, uuid, integer)
  to anon, authenticated, service_role;
grant execute on function public.search_persons(uuid, text, text, text, integer)
  to anon, authenticated, service_role;
