-- Server-side idempotent upsert into public.raw_events.
--
-- Called from /api/v1/raw_events after the route has authenticated the
-- caller via validateApiKey (or session). The SECURITY DEFINER wrapper
-- lets the route write under the anon key without needing service_role.
-- Same pattern as record_merge_audit.
--
-- plpgsql `FOUND` is the correct signal for ON CONFLICT DO NOTHING:
-- it is set to TRUE when the insert actually wrote a row and FALSE
-- when the conflict target fired. A RETURNING-into-variable does NOT
-- work here — on a swallowed conflict the assignment doesn't execute
-- and the variable keeps its previous value.

create or replace function public.upsert_raw_events(
  p_user_id uuid,
  p_rows jsonb
) returns table (inserted int, updated int)
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
    insert into public.raw_events (
      user_id, source, source_event_id, channel, connector_version,
      occurred_at, direction, thread_id,
      participants_raw, participant_phones, participant_emails,
      body_preview, attachments_present, raw_ref
    ) values (
      p_user_id,
      v_row->>'source',
      v_row->>'source_event_id',
      v_row->>'channel',
      v_row->>'connector_version',
      (v_row->>'occurred_at')::timestamptz,
      v_row->>'direction',
      v_row->>'thread_id',
      coalesce(v_row->'participants_raw', '[]'::jsonb),
      coalesce(
        (select array_agg(value::text) from jsonb_array_elements_text(v_row->'participant_phones')),
        array[]::text[]
      ),
      coalesce(
        (select array_agg(value::text) from jsonb_array_elements_text(v_row->'participant_emails')),
        array[]::text[]
      ),
      v_row->>'body_preview',
      coalesce((v_row->>'attachments_present')::boolean, false),
      v_row->'raw_ref'
    )
    on conflict (user_id, source, source_event_id) do nothing;

    if FOUND then
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  inserted := v_inserted;
  updated := (jsonb_array_length(p_rows) - v_inserted);
  return next;
end;
$$;

revoke all on function public.upsert_raw_events(uuid, jsonb) from public;
grant execute on function public.upsert_raw_events(uuid, jsonb) to anon, authenticated, service_role;
