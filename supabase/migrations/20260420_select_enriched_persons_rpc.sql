-- Server-side latest-wins card merge for /api/v1/persons/enriched.
--
-- Motivation: the JS route previously looped over person_ids and called
-- select_person_observations + assembleCard per person. At limit=5 it
-- took 5.3 s; at the full 1,602 persons, ~9 minutes. Dashboard retrofit
-- blocked on this.
--
-- Contract: identical semantics to src/lib/card-assembler.ts but folded
-- server-side in one SQL round-trip.
--
-- Fold algorithm (mirror of assembleCard):
--   1. Observations sorted observed_at ASC (ties broken by ingested_at ASC).
--   2. For kind='person': fold non-null name/company/title/category/
--      relationship_to_me (latest wins); union phones/emails preserving
--      insertion order (mirrors JS `new Set`).
--   3. For kind='correction': overwrite the named scalar field; for
--      phones/emails, CLEAR + RESET from new_value (array).
--   4. Enriched filter: category <> 'other' OR
--      (relationship_to_me is non-empty AND NOT LIKE 'Appears in%').
--
-- SECURITY DEFINER so the route using the ANON key bypasses RLS;
-- p_user_id must be passed explicitly (mirrors select_persons_page).
--
-- Cursor pagination on persons.id ascending — same shape as
-- select_persons_page. Every returned row carries page_last_id (the
-- largest persons.id scanned in this page) so the caller can set
-- next_cursor without a second round-trip. If the page scanned fewer
-- than p_limit person rows, page_last_id is NULL.

CREATE OR REPLACE FUNCTION public.select_enriched_persons(
  p_user_id uuid,
  p_cursor uuid DEFAULT NULL,
  p_limit integer DEFAULT 500
)
RETURNS TABLE (
  id uuid,
  name text,
  phones text[],
  emails text[],
  category text,
  relationship_to_me text,
  company text,
  title text,
  updated_at timestamptz,
  page_last_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(p_limit, 1), 2000);
  v_page_ids uuid[];
  v_last_id uuid;
  v_person_id uuid;
  v_row record;
  v_emitted_any boolean := false;

  v_name text;
  v_company text;
  v_title text;
  v_category text;
  v_relationship text;
  v_phones text[];
  v_emails text[];
  v_last_observed timestamptz;

  v_payload jsonb;
  v_field text;
  v_new_value jsonb;
  v_enriched boolean;
  v_item text;
BEGIN
  -- Step 1: page of persons for this user (cursor-paginated, ASC by id).
  SELECT COALESCE(array_agg(pp.pid ORDER BY pp.pid ASC), ARRAY[]::uuid[])
    INTO v_page_ids
    FROM (
      SELECT public.persons.id AS pid
        FROM public.persons
       WHERE public.persons.user_id = p_user_id
         AND (p_cursor IS NULL OR public.persons.id > p_cursor)
       ORDER BY public.persons.id ASC
       LIMIT v_limit
    ) pp;

  -- Last id in the page — signals a full page so caller can keep paging.
  -- NULL when the page is short (no more persons after this).
  IF array_length(v_page_ids, 1) = v_limit THEN
    v_last_id := v_page_ids[v_limit];
  ELSE
    v_last_id := NULL;
  END IF;

  IF array_length(v_page_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  -- Step 2: per-person fold.
  FOREACH v_person_id IN ARRAY v_page_ids
  LOOP
    v_name := NULL;
    v_company := NULL;
    v_title := NULL;
    v_category := NULL;
    v_relationship := '';
    v_phones := ARRAY[]::text[];
    v_emails := ARRAY[]::text[];
    v_last_observed := NULL;

    FOR v_row IN
      SELECT o.kind, o.observed_at, o.payload
        FROM public.observations o
        JOIN public.person_observation_links l ON l.observation_id = o.id
       WHERE o.user_id = p_user_id
         AND l.person_id = v_person_id
       ORDER BY o.observed_at ASC, o.ingested_at ASC
    LOOP
      v_payload := v_row.payload;

      IF v_row.kind = 'person' THEN
        -- name: JS `if (p.name)` — non-empty string wins.
        IF jsonb_typeof(v_payload->'name') = 'string'
           AND length(v_payload->>'name') > 0 THEN
          v_name := v_payload->>'name';
        END IF;
        -- company: JS `!== undefined && !== null`. JSONB: absent key -> skip;
        -- explicit null -> set NULL; string -> set string.
        IF (v_payload ? 'company')
           AND jsonb_typeof(v_payload->'company') IN ('string','null') THEN
          IF jsonb_typeof(v_payload->'company') = 'null' THEN
            v_company := NULL;
          ELSE
            v_company := v_payload->>'company';
          END IF;
        END IF;
        IF (v_payload ? 'title')
           AND jsonb_typeof(v_payload->'title') IN ('string','null') THEN
          IF jsonb_typeof(v_payload->'title') = 'null' THEN
            v_title := NULL;
          ELSE
            v_title := v_payload->>'title';
          END IF;
        END IF;
        IF jsonb_typeof(v_payload->'category') = 'string'
           AND length(v_payload->>'category') > 0 THEN
          v_category := v_payload->>'category';
        END IF;
        IF jsonb_typeof(v_payload->'relationship_to_me') = 'string'
           AND length(v_payload->>'relationship_to_me') > 0 THEN
          v_relationship := v_payload->>'relationship_to_me';
        END IF;
        -- phones: insertion-order dedup. Mirrors JS Set semantics.
        IF jsonb_typeof(v_payload->'phones') = 'array' THEN
          FOR v_item IN SELECT jsonb_array_elements_text(v_payload->'phones')
          LOOP
            IF v_item IS NOT NULL AND NOT (v_item = ANY(v_phones)) THEN
              v_phones := v_phones || v_item;
            END IF;
          END LOOP;
        END IF;
        IF jsonb_typeof(v_payload->'emails') = 'array' THEN
          FOR v_item IN SELECT jsonb_array_elements_text(v_payload->'emails')
          LOOP
            IF v_item IS NOT NULL AND NOT (v_item = ANY(v_emails)) THEN
              v_emails := v_emails || v_item;
            END IF;
          END LOOP;
        END IF;

      ELSIF v_row.kind = 'correction' THEN
        v_field := v_payload->>'field';
        v_new_value := v_payload->'new_value';
        IF v_field = 'name' AND jsonb_typeof(v_new_value) = 'string' THEN
          v_name := v_payload->>'new_value';
        ELSIF v_field = 'company' AND jsonb_typeof(v_new_value) IN ('string','null') THEN
          IF jsonb_typeof(v_new_value) = 'null' THEN
            v_company := NULL;
          ELSE
            v_company := v_payload->>'new_value';
          END IF;
        ELSIF v_field = 'title' AND jsonb_typeof(v_new_value) IN ('string','null') THEN
          IF jsonb_typeof(v_new_value) = 'null' THEN
            v_title := NULL;
          ELSE
            v_title := v_payload->>'new_value';
          END IF;
        ELSIF v_field = 'category' AND jsonb_typeof(v_new_value) = 'string' THEN
          v_category := v_payload->>'new_value';
        ELSIF v_field = 'relationship_to_me' AND jsonb_typeof(v_new_value) = 'string' THEN
          v_relationship := v_payload->>'new_value';
        ELSIF v_field = 'phones' AND jsonb_typeof(v_new_value) = 'array' THEN
          v_phones := ARRAY[]::text[];
          FOR v_item IN SELECT jsonb_array_elements_text(v_new_value)
          LOOP
            IF v_item IS NOT NULL AND NOT (v_item = ANY(v_phones)) THEN
              v_phones := v_phones || v_item;
            END IF;
          END LOOP;
        ELSIF v_field = 'emails' AND jsonb_typeof(v_new_value) = 'array' THEN
          v_emails := ARRAY[]::text[];
          FOR v_item IN SELECT jsonb_array_elements_text(v_new_value)
          LOOP
            IF v_item IS NOT NULL AND NOT (v_item = ANY(v_emails)) THEN
              v_emails := v_emails || v_item;
            END IF;
          END LOOP;
        END IF;
      END IF;

      IF v_last_observed IS NULL OR v_row.observed_at > v_last_observed THEN
        v_last_observed := v_row.observed_at;
      END IF;
    END LOOP;

    v_enriched := (
      (v_category IS NOT NULL AND v_category <> 'other')
      OR (v_relationship IS NOT NULL
          AND length(v_relationship) > 0
          AND v_relationship NOT LIKE 'Appears in%')
    );

    IF v_enriched THEN
      id := v_person_id;
      name := v_name;
      phones := v_phones;
      emails := v_emails;
      category := v_category;
      relationship_to_me := v_relationship;
      company := v_company;
      title := v_title;
      updated_at := v_last_observed;
      page_last_id := v_last_id;
      v_emitted_any := true;
      RETURN NEXT;
    END IF;
  END LOOP;

  -- If the page was full but every row was filtered out, we still need
  -- to surface the cursor so the caller can keep paging. Emit a sentinel
  -- row with id=NULL carrying only page_last_id. The caller filters
  -- id=NULL rows out of `persons[]` but uses page_last_id for next_cursor.
  IF NOT v_emitted_any AND v_last_id IS NOT NULL THEN
    id := NULL;
    name := NULL;
    phones := NULL;
    emails := NULL;
    category := NULL;
    relationship_to_me := NULL;
    company := NULL;
    title := NULL;
    updated_at := NULL;
    page_last_id := v_last_id;
    RETURN NEXT;
  END IF;

  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.select_enriched_persons(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.select_enriched_persons(uuid, uuid, integer) TO anon, authenticated, service_role;
