# 06 · Operating rules

> How we work. Read before taking any risky action. Update when a lesson earns its scar.

## Rules of engagement

### 1. No claim without evidence

"It works" is never an accepted answer. Every non-trivial claim lands in [outputs/verification-log.md](../outputs/verification-log.md) with a method + an artifact path + the commit sha. If you can't produce the artifact, the claim doesn't hold — say so out loud. Testing contract detail in [docs/superpowers/specs/2026-04-18-testing-and-verification.md](../docs/superpowers/specs/2026-04-18-testing-and-verification.md).

### 2. Real data beats synthetic

Before writing a fixture, `.schema` or `MATCH` against the actual source. The prior session invented wacli column names that didn't exist and lost an hour rebuilding. The only fixture we hand-wrote without checking the source was the one that failed.

### 3. UTF-8 sanitize WhatsApp text

WhatsApp messages embed NULs (`\u0000`) and unpaired UTF-16 surrogates. Both break Postgres JSONB. The sanitizer pattern lives in [scripts/fast-copy-wacli-to-raw-events.mjs](../scripts/fast-copy-wacli-to-raw-events.mjs) — copy that function for any future text-carrying writer.

### 4. Hard cutover. No backward-compat shims.

When you replace code, delete the old version cleanly. **Do not** add re-exports, aliases, renamed `_unused` variables, `// removed` comments, or feature flags to "ease the transition." If you're worried about breaking a caller, grep first, fix the caller, then delete.

### 5. Log-first, retry-never

On two consecutive HTTP failures, open the server logs before touching retry count, batch size, or timeout. The prior session burned four imports lowering the batch size when the actual problem was a 500 error visible in the first log line.

### 6. One path per problem

Live streaming (2–3 events/sec, HTTP, rate-limited, authenticated) and bulk backfill (tens of thousands of rows, direct Postgres `COPY`, one connection) are different code paths with different failure modes. Don't force one pipe to do both. `/api/v1/raw_events` is the streaming ingress. `fast-copy-wacli-to-raw-events.mjs` is the backfill path. They share only the zod schema.

### 7. Don't narrate plans as progress

Writing "I'm about to do X" is not doing X. State what's true after the action, not what the action will be. This file is a rule, not a retrospective.

### 8. The API is the only writer

Nothing bypasses HTTP to touch `observations` / `persons` / `person_observation_links` directly from application code or agent skills. Every write originates from an agent skill calling the CLI, which calls the HTTP API. SSH-to-DB is dev scaffolding, not a product path. Memory entry: `project_api_is_only_writer.md`.

### 9. CLI is plumbing

The `orbit` CLI (in `orbit-cli-plugin/`) owns arg parsing, HTTP transport, batching, auth, output formatting — nothing else. All LLM judgment (category inference, `relationship_to_me` composition, per-thread topic/sentiment) stays inside observer/resolver/enricher SKILLs and runs in the founder's LLM prompt turn, funded by the founder's token budget. **The CLI binary never holds an `ANTHROPIC_API_KEY`.** If a proposed verb seems to need judgment, push that work back into a SKILL.md instead of teaching the CLI to think. Memory entry: `project_orbit_needs_its_own_cli_plugin.md`.

### 10. Deterministic first, LLM batched for judgment

80/20 split: rules/scripts do bulk phone/email/LID/dedup in seconds; the agent batches LLM only for category/summary/topic (20 persons per turn, not 500 sequential runs). Don't reach for an LLM until a rule can't do it. Memory entry: `project_scale_architecture_deterministic_first.md`.

## Standing authorities

### OK without asking

- Additive Supabase migrations (new tables, functions, indexes)
- **Destructive SQL on Supabase** — it's a test/clone environment (`project_supabase_is_test_env.md`). Take a `pg_dump` first as rollback.
- SSH to claw for inspection or running read-only scripts
- `npm install`, `npm test`, `npx next build`
- Branch pushes to `origin`
- Vercel prod deploys — no external users yet (production is currently torn down by design, `project_orbit_deployment_burned.md`)
- Editing `.env.local` in either repo for new credentials
- Moving files within `docs/` (including to/from `docs/archive/` and `agent-docs/archive/`)

### Requires explicit go

- **Credential rotation** — `ALTER USER`, password resets, API key resets
- **Force-push** to `main` (or any shared branch)
- **Neo4j data deletion** — even though the graph is currently empty, ask before wiping a repopulated one
- **Stopping services or removing files on `claw`** — affects the live VM (`project_openclaw_role.md`)
- **Operations costing real money beyond spec budgets** — Stage 6 enrichment budgeted at ~$5/founder one-shot + ~$2/month steady-state; exceeding that warrants a conversation

When in doubt, stop and ask. The cost of pausing is low; the cost of an unwanted action can erase days of work.

## Applying a Supabase migration

There is no `supabase/migrations/` directory in this repo by convention. DDL is applied directly, one of two ways:

1. **Direct `psql` (preferred for dev + new migrations).** `psql "$SUPABASE_DB_URL" -f path/to/migration.sql`. `SUPABASE_DB_URL` in `.env.local` is the pooler connection string (username includes the project ref). This is how the `raw_events` table + `upsert_raw_events` RPC landed on 2026-04-18. Same path applies for any additive DDL (new tables, views, indexes, functions).
2. **Management API (for scripted/CI flows).** `POST https://api.supabase.com/v1/projects/<project-ref>/database/query` with header `Authorization: Bearer $SUPABASE_ACCESS_TOKEN` and JSON body `{"query": "<sql>"}`. Project ref is the subdomain of `NEXT_PUBLIC_SUPABASE_URL` (e.g. `xrfcmjllsotkwxxkfamb` from `https://xrfcmjllsotkwxxkfamb.supabase.co`).

After any DDL change, immediately: (a) commit the `.sql` file under `scripts/migrations/<NNN>-name.sql` as a runnable artifact; (b) run `psql "$SUPABASE_DB_URL" -c "\d <new_table>"` (or equivalent) to confirm; (c) append a verification-log row. **Never run a destructive `DROP` or `TRUNCATE` without explicit go** — that's the authorities boundary above.

## Deploying to Vercel + the claw plugin

- **Vercel prod** auto-deploys on `git push origin main`. No manual step. URL: `orbit-mu-roan.vercel.app`. Rollback: `vercel rollback <previous-deployment-id>` (do the rehearsal once before you need it — CC-4 in the roadmap).
- **Claw VM** is reachable as `ssh claw` — the host entry lives in the founder's local `~/.ssh/config`, not in-repo. User is `sanchay`; plugins live under `~/.openclaw/plugins/`. After deploying a new plugin: `systemctl --user restart openclaw-gateway.service` and tail `journalctl --user -u openclaw-gateway -f` to confirm it boots clean.

## Verification log format

Every claim-worthy action lands a row in [outputs/verification-log.md](../outputs/verification-log.md) using this shape:

```
YYYY-MM-DD HH:MM  TRACK=<n>  CLAIM="<one-line claim>"
  evidence: <path to artifact>
  method:   <one sentence — how you verified>
  result:   PASS / FAIL — <one line of detail>
  commit:   <sha7>
```

Artifacts live under `outputs/verification/<date>-<slug>/`. The ledger is append-only; corrections get their own dated row, they don't edit prior rows.

Full protocol + artifact conventions: [testing spec §3](../docs/superpowers/specs/2026-04-18-testing-and-verification.md).

## When to pause and ask

Beyond the "requires explicit go" list, pause whenever:

- A production API breaking change is on the table
- An operation touches data that isn't rebuildable from `raw_events`
- A Neo4j schema change can't be rolled forward (DROP CONSTRAINT or similar)
- A migration will rewrite existing rows rather than append new ones

Detail: [testing spec §9](../docs/superpowers/specs/2026-04-18-testing-and-verification.md).

## Commit message template

Per [testing spec §8](../docs/superpowers/specs/2026-04-18-testing-and-verification.md):

```
<track>: <what changed>

Evidence:
  - <artifact path>
  - test output: <command + pass/fail>
  - claim: <specific testable claim>

Rollback:
  - <one-line command or git-revert reference>
```

If a commit can't cite all three, it doesn't land on `main` — it lands on a branch until the evidence exists.
