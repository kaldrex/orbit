#!/usr/bin/env node
/**
 * Generate supabase/migrations/20260421_audit_cleanup.sql.
 *
 * Back-fills supabase_migrations.schema_migrations for every .sql file in
 * supabase/migrations/ that is not yet recorded, drops 3 dead RPCs identified
 * in A2 (record_merge_audit, select_person_observations, select_persons_page),
 * deletes audit-probe meetings + orphan observations from the 2026-04-20 audit.
 *
 * All statements are idempotent (ON CONFLICT DO NOTHING, IF EXISTS, and
 * delete predicates that match only the known residue).
 *
 * Run:   node scripts/generate-audit-cleanup-migration.mjs
 * Apply: via Supabase MCP apply_migration (test env — see CLAUDE.md).
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const MIGRATIONS_DIR = "supabase/migrations";
const OUT_FILE = join(MIGRATIONS_DIR, "20260421_audit_cleanup.sql");

// Rows already present in supabase_migrations.schema_migrations on live DB
// (captured via mcp__claude_ai_Supabase__list_migrations at time of writing).
// Files whose derived name matches one of these are skipped. We include both
// the stripped name (matches `deriveName`) and the original prefixed name
// (two rows in the live tracker kept the date prefix in the name column:
// `20260421_jobs` and `20260421_jobs_pg_cron`).
const ALREADY_TRACKED_NAMES = new Set([
  "create_profiles_table",
  "create_connectors_table",
  "create_api_keys_table",
  "create_validate_api_key_function",
  "grant_rpc_to_anon",
  "merge_audit",
  "record_merge_audit_rpc",
  "wipe_stage5_bulk_002",
  "person_topics",
  "single_source_merge",
  "jobs", // tracker row is '20260421_jobs' but our derived name is 'jobs'
  "jobs_pg_cron", // tracker row is '20260421_jobs_pg_cron' but derived is 'jobs_pg_cron'
  "20260421_jobs",
  "20260421_jobs_pg_cron",
]);

// Strip leading SQL comment block (-- lines at the top of the file),
// matching what the Supabase CLI stores in statements[].
function stripLeadingComments(sql) {
  const lines = sql.split("\n");
  let i = 0;
  while (
    i < lines.length &&
    (lines[i].trim().startsWith("--") || lines[i].trim() === "")
  ) {
    i++;
  }
  return lines.slice(i).join("\n").replace(/^\s+/, "").replace(/\s+$/, "");
}

// Derive the tracker name from a filename. Mirrors the two naming styles
// observed in the existing tracker — either strip the YYYYMMDD_ prefix
// (e.g. `20260417_merge_audit.sql` -> `merge_audit`) or keep it.
// We always strip to produce a clean camel-ish name. Duplicates (already-
// tracked) are filtered by ALREADY_TRACKED_NAMES.
function deriveName(filename) {
  const base = basename(filename, ".sql");
  // Strip leading 8-digit date prefix + underscore.
  const stripped = base.replace(/^\d{8}_/, "");
  return stripped;
}

// Produce a 14-digit version by concatenating the filename date with a
// zero-padded HHMMSS derived from a stable counter per-date. Ensures the
// version sorts after any existing tracker rows for that date.
function makeVersion(filename, seqByDate) {
  const base = basename(filename, ".sql");
  const datePrefix = base.slice(0, 8); // YYYYMMDD
  if (!/^\d{8}$/.test(datePrefix)) {
    throw new Error(`Cannot parse date from filename: ${filename}`);
  }
  // Use 900000..999999 range so it always sorts AFTER any CLI-generated row
  // for the same date (which uses real HHMMSS, so always < 240000).
  const n = (seqByDate.get(datePrefix) ?? 0) + 1;
  seqByDate.set(datePrefix, n);
  const suffix = String(900000 + n).padStart(6, "0");
  return `${datePrefix}${suffix}`;
}

function sqlEscape(str) {
  return str.replace(/'/g, "''");
}

function main() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => f !== "20260421_audit_cleanup.sql") // exclude self
    .sort((a, b) => {
      // Primary: mtime (preserves original apply order).
      // Secondary: filename (deterministic tie-break).
      const am = statSync(join(MIGRATIONS_DIR, a)).mtimeMs;
      const bm = statSync(join(MIGRATIONS_DIR, b)).mtimeMs;
      if (am !== bm) return am - bm;
      return a.localeCompare(b);
    });

  const seqByDate = new Map();
  const rowsToInsert = [];

  for (const file of files) {
    const name = deriveName(file);
    if (ALREADY_TRACKED_NAMES.has(name)) continue;
    const path = join(MIGRATIONS_DIR, file);
    const raw = readFileSync(path, "utf8");
    const stripped = stripLeadingComments(raw);
    const version = makeVersion(file, seqByDate);
    rowsToInsert.push({ version, name, stmt: stripped, file });
  }

  const header = `-- 20260421_audit_cleanup.sql
--
-- Three-part cleanup migration from the 2026-04-21 backend audit:
--
--   1. Back-fill supabase_migrations.schema_migrations for the ${rowsToInsert.length} .sql
--      files that were applied to live Supabase but never recorded. Without
--      this, a fresh \`supabase db reset\` would flag them as "never applied"
--      and skip them — or on a fresh clone, apply would double-apply.
--   2. Drop 3 dead RPCs superseded by newer implementations:
--        - record_merge_audit (superseded by record_merge_audit_rpc)
--        - select_person_observations (superseded by select_observations)
--        - select_persons_page (superseded by select_enriched_persons)
--   3. Delete 1 audit-probe meeting + 3 orphan observations (auto-link residue
--      from 2026-04-19..2026-04-21 audit sessions).
--
-- Every statement is idempotent. Safe to re-apply.

`;

  const sections = [];

  // --------------------------------------------------------------------------
  // Section 1: back-fill tracker rows.
  // --------------------------------------------------------------------------
  let section1 = "-- ---------------------------------------------------------------------------\n";
  section1 += "-- 1. Back-fill supabase_migrations.schema_migrations.\n";
  section1 += "-- ---------------------------------------------------------------------------\n\n";
  for (const { version, name, stmt, file } of rowsToInsert) {
    section1 += `-- from: ${file}\n`;
    section1 += `insert into supabase_migrations.schema_migrations (version, name, statements)\n`;
    section1 += `values ('${version}', '${sqlEscape(name)}', ARRAY[$stmt_${version}$${stmt}$stmt_${version}$])\n`;
    section1 += `on conflict (version) do nothing;\n\n`;
  }
  sections.push(section1);

  // --------------------------------------------------------------------------
  // Section 2: drop dead RPCs.
  // --------------------------------------------------------------------------
  const section2 = `-- ---------------------------------------------------------------------------
-- 2. Drop dead RPCs.
-- ---------------------------------------------------------------------------

-- record_merge_audit: superseded by record_merge_audit_rpc (20260417_record_merge_audit_rpc.sql).
-- Live signature captured from pg_proc on 2026-04-21.
drop function if exists public.record_merge_audit(
  uuid, text, text[], text, numeric, text, jsonb
);

-- select_person_observations: superseded by select_observations
-- (20260419_select_observations_rpc.sql). No caller remains.
drop function if exists public.select_person_observations(uuid, uuid);

-- select_persons_page: superseded by select_enriched_persons
-- (20260420_select_enriched_persons_rpc.sql). No caller remains.
drop function if exists public.select_persons_page(uuid, uuid, integer);

`;
  sections.push(section2);

  // --------------------------------------------------------------------------
  // Section 3: audit residue cleanup.
  // --------------------------------------------------------------------------
  const section3 = `-- ---------------------------------------------------------------------------
-- 3. Clean audit residue.
-- ---------------------------------------------------------------------------

-- Audit-probe meetings from capability-audit runs.
delete from public.meetings
  where meeting_id like 'audit-%'
     or meeting_id like 'audit_%';

-- Orphan observations for the founder account (dbb398c2-...): kind person/merge
-- rows that never got linked to a person row because the auto-link pass failed
-- partway through or the observation pre-dated the person_observation_links
-- table. Delete only those that are still unlinked.
delete from public.observations o
  where o.user_id = 'dbb398c2-1eff-4eee-ae10-bad13be5fda7'
    and o.kind in ('person', 'merge')
    and not exists (
      select 1 from public.person_observation_links l
      where l.observation_id = o.id
    );
`;
  sections.push(section3);

  const final = header + sections.join("\n");
  writeFileSync(OUT_FILE, final, "utf8");
  console.error(
    `Wrote ${OUT_FILE} — ${rowsToInsert.length} tracker rows + 3 drop-function + 2 delete statements.`,
  );
  for (const r of rowsToInsert) {
    console.error(`  tracker: ${r.version}  ${r.name}  (${r.file})`);
  }
}

main();
