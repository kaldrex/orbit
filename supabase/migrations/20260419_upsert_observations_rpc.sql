-- Server-side idempotent insert into public.observations.
--
-- Called from POST /api/v1/observations after the route has
-- authenticated the caller via getAgentOrSessionAuth. SECURITY DEFINER
-- lets the route write under the anon key without service_role. Same
-- pattern as upsert_raw_events.
--
-- dedup_key is computed by the BEFORE INSERT trigger on observations
-- (see 20260419_observations.sql). ON CONFLICT (user_id, dedup_key)
-- DO NOTHING swallows re-posts; FOUND is the correct signal for
-- "this row actually inserted".

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
begin
  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    insert into public.observations (
      user_id, observed_at, observer, kind, evidence_pointer,
      confidence, reasoning, payload
    ) values (
      p_user_id,
      (v_row->>'observed_at')::timestamptz,
      v_row->>'observer',
      v_row->>'kind',
      v_row->>'evidence_pointer',
      (v_row->>'confidence')::numeric,
      v_row->>'reasoning',
      v_row->'payload'
    )
    on conflict (user_id, dedup_key) do nothing;

    if FOUND then
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  inserted := v_inserted;
  deduped := (jsonb_array_length(p_rows) - v_inserted);
  return next;
end;
$$;

revoke all on function public.upsert_observations(uuid, jsonb) from public;
grant execute on function public.upsert_observations(uuid, jsonb) to anon, authenticated, service_role;
