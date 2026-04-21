-- /api/v1/self/init backing RPC.
--
-- Resolves the authed user's own person_id by scanning `kind='person'`
-- observations for one whose payload.emails contains any of the provided
-- candidate addresses (ORBIT_SELF_EMAIL may be comma-separated in the
-- route), falling back to payload.phones vs ORBIT_SELF_PHONE. Writes the
-- result to profiles.self_node_id so subsequent reads go through the fast
-- path, and returns the resolved id.
--
-- Idempotent: if profiles.self_node_id is already set, returns it without
-- rescanning observations (route layer handles the short-circuit too, but
-- we re-assert here for direct RPC callers).

create or replace function public.resolve_self_node_id(
  p_user_id uuid,
  p_emails text[] default '{}',
  p_phones text[] default '{}'
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing text;
  v_match_id uuid;
  v_email_lc text[];
begin
  -- Short-circuit: already resolved.
  select self_node_id into v_existing
    from public.profiles
    where id = p_user_id;
  if v_existing is not null and length(v_existing) > 0 then
    return v_existing;
  end if;

  -- Lowercase the candidate emails for case-insensitive containment.
  select array_agg(lower(e)) into v_email_lc
    from unnest(coalesce(p_emails, '{}'::text[])) e
    where e is not null and length(trim(e)) > 0;

  if v_email_lc is not null and array_length(v_email_lc, 1) > 0 then
    -- Find a person linked to a `kind='person'` observation whose
    -- payload.emails (lowercased) intersects any candidate. Most-recent
    -- observation wins on tie to stabilise re-resolves after renames.
    select l.person_id into v_match_id
      from public.observations o
      join public.person_observation_links l
        on l.observation_id = o.id
      where o.user_id = p_user_id
        and o.kind = 'person'
        and exists (
          select 1
            from jsonb_array_elements_text(coalesce(o.payload->'emails', '[]'::jsonb)) e
            where lower(e) = any(v_email_lc)
        )
      order by o.observed_at desc
      limit 1;
  end if;

  -- Phone fallback — same shape, against payload.phones.
  if v_match_id is null
     and p_phones is not null
     and array_length(p_phones, 1) > 0
  then
    select l.person_id into v_match_id
      from public.observations o
      join public.person_observation_links l
        on l.observation_id = o.id
      where o.user_id = p_user_id
        and o.kind = 'person'
        and exists (
          select 1
            from jsonb_array_elements_text(coalesce(o.payload->'phones', '[]'::jsonb)) p
            where p = any(p_phones)
        )
      order by o.observed_at desc
      limit 1;
  end if;

  if v_match_id is null then
    return null;
  end if;

  update public.profiles
     set self_node_id = v_match_id::text
     where id = p_user_id;

  return v_match_id::text;
end;
$$;

revoke all on function public.resolve_self_node_id(uuid, text[], text[]) from public;
grant execute on function public.resolve_self_node_id(uuid, text[], text[])
  to anon, authenticated, service_role;
