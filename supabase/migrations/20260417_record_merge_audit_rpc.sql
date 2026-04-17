-- SECURITY DEFINER RPC for audit writes.
--
-- The server's /api/v1/merge endpoint authenticates callers via API key
-- (validated through validate_api_key RPC) or session cookie, then needs
-- to write a merge_audit row under that user_id. Our anon Supabase client
-- has no JWT for API-key callers, so the row-level INSERT policy can't
-- verify auth.uid() = user_id and the direct insert fails silently.
--
-- This function accepts a pre-authenticated user_id from the server, does
-- light validation, and inserts on behalf of that user with elevated
-- privilege. Callable by anon + authenticated; returns the new row id.

create or replace function public.record_merge_audit(
  p_user_id uuid,
  p_canonical_id text,
  p_merged_ids text[],
  p_reasoning text,
  p_confidence numeric,
  p_source text,
  p_evidence jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_source not in ('auto', 'llm', 'user') then
    raise exception 'invalid source %', p_source;
  end if;
  if p_confidence is not null and (p_confidence < 0 or p_confidence > 1) then
    raise exception 'confidence out of range';
  end if;
  insert into public.merge_audit (user_id, canonical_id, merged_ids, reasoning, confidence, source, evidence)
  values (p_user_id, p_canonical_id, p_merged_ids, p_reasoning, p_confidence, p_source, p_evidence)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.record_merge_audit from public;
grant execute on function public.record_merge_audit(uuid, text, text[], text, numeric, text, jsonb) to anon, authenticated, service_role;
