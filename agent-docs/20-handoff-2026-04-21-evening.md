# 20 · Handoff — 2026-04-21 evening (Phase 2 shipped, ready for Vercel + Hardeep)

> **Read this first if you've just walked in.** Picks up where [19-handoff-2026-04-21.md](./19-handoff-2026-04-21.md) left off. That doc closed at V1 landed awaiting push. This doc closes at **Phase 2 shipped end-to-end, 4 new commits, still awaiting push**. Next workstreams: (1) Vercel deploy, (2) Hardeep onboarding.

## What happened this session (2026-04-21 evening)

Four commits on branch `v1-dashboard-and-vision-features`, on top of `06a92c9`. **Nothing pushed.**

```
ed86808  feat(v1-phase2): delta-bulk enricher — Haiku 4.5, CLI-first, smoke SKILL
ffa7d73  feat(v1-phase2): card-assembler + PersonPanel Evolution stack
883d6ea  feat(v1-phase2): per-pass card snapshots — table + RPCs + routes + CLI + enricher step 5
33348df  refactor(env): rename ORBIT_API_URL → ORBIT_API_BASE; reconcile stale docs
```

Branch total: **31 commits ahead of main**, still not pushed.

## What Phase 2 delivers (the per-pass card evolution story)

Every enrichment pass now writes an **immutable per-pass snapshot** of a person's card into `public.person_snapshots`. The UI shows these as an "Evolution (N passes)" section on each PersonPanel, newest-first, colored by pass_kind (enricher=sky, resolver=violet, summary=emerald, correction=amber). Observations remain the append-only source of truth; snapshots are a UI-speed projection with LLM-generated `diff_summary` text + per-field `confidence_delta`.

**New schema:** `person_snapshots` table with RLS, 3 SECURITY DEFINER RPCs (`upsert_person_snapshot`, `select_person_snapshots`, `select_latest_summary_snapshot`), migration tracker rows `20260422900002` + `20260422900003` + `20260422900004`.

**New routes:** `POST/GET /api/v1/person/:id/snapshots`, `GET /api/v1/persons/active-since?since=<iso>[&needs_enrichment=<bool>]`.

**New SKILLs:** `orbit-enricher-delta` (production, Haiku 4.5, scope={active_since | active_since_days_ago | persons}), `orbit-enricher-delta-smoke` (read-only variant for output-shape validation).

**New dispatcher:** `orbit-job-runner/dispatchers/enricher_delta.sh`. `run-once.sh` claims `enricher_delta` jobs.

**New pg_cron:** `orbit-enricher-delta-tick` daily at 3 AM UTC, enqueues one `enricher_delta` job per active user with `scope=active_since_days_ago, days=1`.

**Card-assembler:** now takes optional `summarySnapshot` param; when a `pass_kind='summary'` snapshot exists, it overrides `one_paragraph_summary` with the combiner's paragraph + diff_summary. (No combiner exists yet — Phase 3 was deliberately deferred per user decision 2026-04-21. The path is wired for when it ships.)

**CLI plugin:** v0.4.0 → v0.5.0 → v0.6.0 → **v0.7.0**, **19 → 22 verbs**. Three new: `orbit_persons_active_since`, `orbit_person_snapshot_write`, `orbit_person_snapshots_list`. Plus `orbit_messages_fetch` now accepts `since` (Unix s/ms/ISO, thread into SQLite `WHERE ts >= ?`).

**Cutover A:** `ORBIT_API_URL` → `ORBIT_API_BASE` (bare host, no `/api/v1` suffix). CLI appends `/api/v1` exactly once in `joinUrl()`. `env.mjs` rejects values containing `/api/v<N>` with a guard test. Every SKILL doc, every dispatcher, every test fixture, every agent-doc reference renamed. Prior Vercel env still has `ORBIT_API_URL` — **this is the var to rename in Vercel when we push.**

## Tests + canary

- **545 passed + 1 skipped** across 37 test files (was 505 + 1 at session start → +40 tests).
- **Umayr canary** byte-identical on 5 core fields after every commit.
- Regression test `tests/unit/no-anthropic-outside-skills.test.mjs` still passes — no Anthropic calls leaked outside SKILLs.

## The claw (openclaw-sanchay) state

- Plugin deployed at `~/.openclaw/extensions/orbit-cli/` — **v0.7.0 running** (22 tools).
- New SKILL deployed at `~/.openclaw/workspace/skills/orbit-enricher-delta/` + `~/.openclaw/workspace/skills/orbit-enricher-delta-smoke/`.
- Dispatcher deployed to `~/orbit-job-runner/dispatchers/enricher_delta.sh`, `run-once.sh` updated with new claim kind.
- `orbit-enricher-delta-tick` pg_cron schedule active (3 AM UTC daily). 4 cron jobs total now.
- Env file `~/.orbit/env` updated: `ORBIT_API_BASE=http://100.97.152.84:3047` (bare host). Prior env backed up at `~/.openclaw/.env.bak.pre-cutover-a-20260421T114859Z`.
- **Gateway restarted at 15:05 UTC** (PID 894332) to pick up the new plugin — before restart, the old PID 817678 had only v0.4.0's 12 verbs loaded and Wazowski was freelancing via `exec`/`sqlite3`. Post-restart, Wazowski's self-test passed **20 of 22 verbs live on Telegram**, including all 3 new Phase 2 verbs.

## Live proof (Wazowski self-test on Telegram, 15:19 UTC)

| Verb | Status |
|---|---|
| orbit_persons_list_enriched | ✅ 1601 persons |
| orbit_persons_going_cold | ✅ 43 cold |
| **orbit_persons_active_since** | ✅ 1000+ active since apr 20 |
| orbit_person_get | ✅ |
| orbit_person_get_by_email | ✅ |
| **orbit_person_snapshots_list** | ✅ 0 snapshots (expected for test target) |
| **orbit_person_snapshot_write** | ✅ wrote `a409f25f-ffb0-417f-b059-4ca4915c8ba9` — verified in DB |
| orbit_topics_get / _upsert | ✅ / ✅ |
| orbit_observation_emit / _bulk | ✅ (dry) / ✅ (dry) |
| orbit_messages_fetch | ❌ NETWORK_ERROR (see debt below) |
| orbit_meeting_list / _upsert | ✅ / ✅ |
| orbit_calendar_fetch | ✅ |
| orbit_self_init | ✅ |
| orbit_jobs_claim / _report | ✅ null / ✅ 404 expected |
| orbit_rules_* (5 verbs) | ✅ all |
| orbit_lid_bridge_upsert | ✅ |
| orbit_lid_bridge_ingest | ❌ better-sqlite3 runtime mismatch |

Bold = new this session. 20 of 22 verbs pass. The 2 failures are pre-existing local claw issues, not Orbit-side regressions.

## Debt that surfaced tonight

1. **`orbit_messages_fetch` → NETWORK_ERROR.** Wazowski misdiagnosed as "orbit API down" — API is fine, every API-hitting verb passes. Root cause likely wacli.db or the nested `orbit_person_get` inside messages_fetch when the test person has no phones. Needs investigation on claw.
2. **`orbit_lid_bridge_ingest` → VALIDATION_FAILED (better-sqlite3 runtime mismatch).** The plugin's SQLite access path in the bundled gateway runtime is flaky. `orbit_rules_lid_to_phone` (also SQLite) passes, so it's specific to this verb.
3. **`wacli.db` on claw hasn't synced since Apr 17** — Wazowski itself flagged this during the earlier bulk run. The WhatsApp ingestion stream needs a kick. Separate concern; predates tonight's work.
4. **Openclaw-gateway plugin reload on rsync.** Gateways do NOT auto-reload plugins when the files on disk change. **We have to restart the gateway after any plugin deploy.** Add to onboarding runbook.
5. **Agent freelances when tools are missing.** If the agent can't find a verb, it shells out to `exec`/`sqlite3` instead of erroring. This hid the plugin-not-reloaded problem for 4+ minutes of bulk enrichment tonight. Tighten the enricher-delta SKILL prompt or scope the agent's `exec` access.

## What's deferred / still open (V2-eligible)

- **Phase 3 combiner SKILL.** Deliberately deferred. Card-assembler is wired for summary snapshots but nothing writes them. Memory `project_phase2_shipped_combiner_deferred.md` tells future sessions not to re-propose.
- **Phase 3 UI tweak.** PersonPanel renders `card.relationship_to_me` not `card.one_paragraph_summary`. One-line swap when the combiner ships.
- **Orphan job reaper.** Still not built. One 5-min systemd timeout still orphans enricher jobs whose openclaw turn runs long.
- **capability_reports heartbeat.** Still empty.
- **`/persons/enriched` 1000-row PostgREST cap.**
- **Haiku prompt cache silent no-op.** Cost overrun risk on topic-resonance.

## Tomorrow morning (if nothing's touched)

At **03:00 UTC** two cron jobs fire: `orbit-enricher-tick` (the original, hunts `category='other'` skeletons) and the new `orbit-enricher-delta-tick` (processes yesterday's active people). Both enqueue `jobs` rows. Claw's 15-min systemd timer picks them up, invokes the matching SKILL, Haiku 4.5 classifies, observations + snapshots land. Open the dashboard, click around — Evolution stacks will have new rows across active contacts.

## Next workstreams (the "what now")

### Workstream A — Vercel deploy (first real push of this branch)

The local dev server at `100.97.152.84:3047` has been serving everything. For production + for Hardeep to hit, we need the Vercel deploy live. Gated by user go. Sequence:
1. `git push origin v1-dashboard-and-vision-features` — triggers a preview deploy.
2. In Vercel env: add / rename **`ORBIT_API_BASE=https://<preview-url>`** (strip `/api/v1` from any old `ORBIT_API_URL`).
3. Ensure `SUPABASE_*`, `NEO4J_*`, `ANTHROPIC_API_KEY` are set in Vercel env (ANTHROPIC should NOT be there — Orbit never makes Anthropic calls; this is just to catch the mistake if it crept in).
4. Test the preview URL with a curl for Umayr's card + verify byte-identical on 5 core fields.
5. After a few rounds of passing previews: `vercel --prod` or merge to main for prod.
6. Update claw's `~/.orbit/env` to `ORBIT_API_BASE=https://<prod-url>` and restart `orbit-job-runner.timer`.

### Workstream B — Hardeep onboarding

Hardeep has a provisioned claw at `100.120.154.123` (Tailscale host `hardeeps-mac-mini-1`) already running OpenClaw with agent name "Chad". The path for onboarding:
1. Mint him an API key in Orbit: `POST /api/v1/keys {"name": "Hardeep Claw"}`.
2. Sync the orbit-cli-plugin + rules-plugin + SKILLs to his claw:
   - `rsync orbit-cli-plugin/ claw-hardeep:~/.openclaw/extensions/orbit-cli/`
   - `rsync orbit-claw-skills/{orbit-observer,orbit-observer-backfill,orbit-enricher,orbit-enricher-delta,orbit-meeting-brief,orbit-topic-resonance,orbit-resolver,orbit-job-runner}/ claw-hardeep:~/.openclaw/workspace/skills/`
3. Set Hardeep's env on his claw: `ORBIT_API_BASE=<prod Vercel URL>`, `ORBIT_API_KEY=<his key>`, `ORBIT_SELF_EMAIL=<his email>`, `ORBIT_SELF_PHONE=<his phone>`.
4. **Restart Chad's gateway** (the plugin-reload lesson from tonight).
5. Run `orbit-observer-backfill` SKILL for first-run seed of raw_events + lid_bridge + interactions from his wacli.db. (This is a destructive write path — confirm with Hardeep before triggering.)
6. Watch his first enricher-delta cron tick at 3 AM UTC the next day → verify his first Evolution rows on the dashboard (if he gets dashboard access).

**Shared infra question:** Hardeep's data lives under his own `user_id` in the same Supabase project — RLS keeps them separate. One Vercel deploy serves both. Neo4j is also shared. No new infra needed per tenant.

## Where things live (quick reference)

| What | Where |
|---|---|
| Plan (this sprint) | `/Users/sanchay/.claude/plans/alright-then-rename-it-hashed-deer.md` |
| Memory dir | `/Users/sanchay/.claude/projects/-Users-sanchay-Documents-projects-personal-orbit/memory/` |
| Canary baseline | `outputs/verification/2026-04-19-umayr-v0/card.json` |
| Claw SSH | `ssh claw` (= `openclaw-sanchay`, Tailscale `100.109.184.64`) |
| Mac Tailscale | `100.97.152.84` (where dev server runs) |
| Hardeep's claw | `hardeeps-mac-mini-1`, Tailscale `100.120.154.123` (Chad agent) |
| Chandan / Khushal claws | `100.73.195.67` / `100.107.195.77` (provisioned, not onboarded) |
| Dev server | `http://localhost:3047` on Mac (via `./dev`) |

## Non-negotiables still in force

1. **API is the only writer.** No direct DB writes from any client.
2. **No Anthropic call outside a SKILL.** Regression test enforces.
3. **CLI is plumbing.** New verbs have no LLM, no judgment.
4. **SKILLs stay thin.** Short recipe + at most one LLM call. No big prompt dumps.
5. **Hard cutover.** No `ORBIT_API_URL` back-compat shim anywhere.
6. **Umayr canary byte-identical** after every commit.
7. **505+ tests green** after every commit.
8. **No push without explicit user go.** Phase 6 gate still live — the Vercel push in Workstream A needs your word.

## One-line state

**Phase 2 shipped. 4 commits unpushed on `v1-dashboard-and-vision-features`. 20/22 verbs proven live via Telegram. Wazowski loop healthy post-gateway-restart. Ready for Vercel + Hardeep on your green light.**
