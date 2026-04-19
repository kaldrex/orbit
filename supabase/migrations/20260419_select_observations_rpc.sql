-- Server-side read for observations.
--
-- Called from GET /api/v1/observations (resolver read path) and from
-- GET /api/v1/person/:id/card (card assembler). SECURITY DEFINER lets
-- the route read under the anon key without service_role.
--
-- Cursor pagination: observed_at DESC as the ordering; cursor is the
-- id of the last row returned on the previous page. Postgres orders
-- uuids stably so (observed_at, id) together form a total order.
--
-- Usage:
--   select * from select_observations('<user>', null, null, 100, null);
--   select * from select_observations('<user>', '2026-04-19', 'interaction', 50, '<last-id>');

create or replace function public.select_observations(
  p_user_id uuid,
  p_since timestamptz default null,
  p_kind text default null,
  p_limit int default 1000,
  p_cursor uuid default null
) returns setof public.observations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cursor_observed_at timestamptz;
begin
  if p_cursor is not null then
    select observed_at into v_cursor_observed_at
      from public.observations
      where id = p_cursor and user_id = p_user_id;
  end if;

  return query
    select *
      from public.observations o
     where o.user_id = p_user_id
       and (p_since is null or o.observed_at >= p_since)
       and (p_kind is null or o.kind = p_kind)
       and (
         p_cursor is null
         or v_cursor_observed_at is null
         or o.observed_at < v_cursor_observed_at
         or (o.observed_at = v_cursor_observed_at and o.id < p_cursor)
       )
     order by o.observed_at desc, o.id desc
     limit least(greatest(p_limit, 1), 1000);
end;
$$;

revoke all on function public.select_observations(uuid, timestamptz, text, int, uuid) from public;
grant execute on function public.select_observations(uuid, timestamptz, text, int, uuid) to anon, authenticated, service_role;
