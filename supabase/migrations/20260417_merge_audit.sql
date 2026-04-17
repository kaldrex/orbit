-- Phase 3 — Identity Resolver audit table.
--
-- Records every merge applied to the Neo4j Person graph: the canonical node
-- that survived, the node ids that were folded in, the reasoning, the
-- confidence level, and whether the merge was produced by deterministic
-- rules, an LLM pass, or the user. Keeps a revocation column for Phase 9.5
-- (user corrections — undo a bad merge).
--
-- Append-only. RLS: users can read/write their own rows.

create table if not exists public.merge_audit (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  canonical_id text not null,
  merged_ids text[] not null,
  reasoning text,
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  source text not null check (source in ('auto', 'llm', 'user')),
  evidence jsonb,
  applied_at timestamptz not null default now(),
  reverted_at timestamptz,
  reverted_reason text
);

create index if not exists merge_audit_user_id_applied_at_idx
  on public.merge_audit (user_id, applied_at desc);
create index if not exists merge_audit_canonical_id_idx
  on public.merge_audit (user_id, canonical_id);

alter table public.merge_audit enable row level security;

drop policy if exists "users read own merge audit" on public.merge_audit;
create policy "users read own merge audit" on public.merge_audit
  for select using (auth.uid() = user_id);

drop policy if exists "users insert own merge audit" on public.merge_audit;
create policy "users insert own merge audit" on public.merge_audit
  for insert with check (auth.uid() = user_id);

drop policy if exists "users update own merge audit" on public.merge_audit;
create policy "users update own merge audit" on public.merge_audit
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
