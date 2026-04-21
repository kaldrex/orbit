-- Cursor-paginated read over raw_events for the caller.
--
-- Used by GET /api/v1/raw_events, invoked by the orbit-cli
-- `orbit_interactions_backfill` verb during onboarding: the observer
-- backfill SKILL on a new founder's claw reads raw_events via this
-- projection, builds interaction observations, and POSTs them back
-- through /api/v1/observations. Reads via API (never direct DB) is a
-- load-bearing invariant — see CLAUDE.md §6.
--
-- Ordered ascending by (occurred_at, id) so the pipeline can fold
-- chronologically. Cursor is the last (occurred_at, id) pair of the
-- prior page, serialized as text "ISO8601|uuid".
--
-- Filters:
--   p_source — optional, e.g. 'whatsapp'. Null = all sources.
--   p_limit  — 1..1000, defaults enforced by caller.
--
-- SECURITY DEFINER with caller-match on user_id.

create or replace function public.select_raw_events(
  p_user_id uuid,
  p_source text default null,
  p_cursor_occurred_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit integer default 100
) returns setof public.raw_events
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    select r.*
      from public.raw_events r
     where r.user_id = p_user_id
       and (p_source is null or r.source = p_source)
       and (
         p_cursor_occurred_at is null
         or r.occurred_at > p_cursor_occurred_at
         or (r.occurred_at = p_cursor_occurred_at and r.id > p_cursor_id)
       )
     order by r.occurred_at asc, r.id asc
     limit greatest(1, least(coalesce(p_limit, 100), 1000));
end;
$$;

revoke all on function public.select_raw_events(uuid, text, timestamptz, uuid, integer) from public;
grant execute on function public.select_raw_events(uuid, text, timestamptz, uuid, integer) to anon, authenticated, service_role;
