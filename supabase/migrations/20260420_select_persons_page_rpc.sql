-- Paginated person_id lookup for /api/v1/persons/enriched.
-- SECURITY DEFINER so route handlers using the ANON key can bypass RLS,
-- matching the pattern used by select_observations + select_person_observations.
-- Caller MUST pass p_user_id explicitly; the function scopes to that user.

CREATE OR REPLACE FUNCTION public.select_persons_page(
  p_user_id uuid,
  p_cursor uuid DEFAULT NULL,
  p_limit integer DEFAULT 500
)
RETURNS TABLE (id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT id FROM persons
  WHERE user_id = p_user_id
    AND (p_cursor IS NULL OR id > p_cursor)
  ORDER BY id ASC
  LIMIT LEAST(GREATEST(p_limit, 1), 2000);
$$;

REVOKE ALL ON FUNCTION public.select_persons_page(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.select_persons_page(uuid, uuid, integer) TO authenticated, anon, service_role;
