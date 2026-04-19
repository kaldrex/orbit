# 11 · V0 Pipeline Handoff — 2026-04-19

> The session that proved the pipeline. Two cards produced end-to-end from real data. The next session scales to ~500 cards, wraps Orbit in an agent-facing CLI, and closes the continuous-update loop.
>
> **Read this doc first.** Everything else (reports, verification artifacts, plans) is referenced from here.

---

## TL;DR

- **We built the observer → basket → resolver → card pipeline.** Observations are immutable/append-only, person records are emergent, the agent is the only writer, Orbit stores + serves cards.
- **It works end-to-end on 2 real humans** (Umayr Sheik, Ramon Berrios). Scorecard 6/6 each: name, phones, emails, cross-source joined, interactions summarized, relationship context. Cards are live and inspectable.
- **108 tests green, 8 commits on worktree branch `worktree-autonomous-2026-04-19`**, not pushed.
- **What's left before V0 feels real**: (1) an `orbit` CLI plugin so the agent stops writing HTTP curls, (2) bulk ingest that processes ~500 humans not 2, (3) continuous-update loop on incoming WA/Gmail, (4) a thin UI for the founder to scroll the network.
- **The arrived-at product frame**: Orbit is a **discovery engine for the long tail of the founder's network**, not a directory of the top 30. Map first, views are cheap queries on top.

---

## 1. The mental model we converged on

### 1.1. What Orbit is

A memory store that holds the founder's cross-channel map of humans. Every human gets one JSON card assembled from observations. The value isn't in the top 30 the founder can recall unassisted — it's the long tail (~400–600 humans across WA + Gmail + Contacts + groups) that the agent surfaces from forgotten signal.

### 1.2. What OpenClaw is

The founder's personal agent (Wazowski on `claw` in our case). It owns the channel credentials, has its own LLM budget, does the reading and the reasoning. It's the ONLY writer into Orbit. SSH-into-the-VM is dev scaffolding, not a product path.

### 1.3. The deterministic/interpretive split

~80% of card-building work is deterministic and doesn't need an LLM — phone normalization, email canonicalization, LID→phone bridge, bot filtering, dedup, bridge-based merges. ~20% is interpretive — category, relationship_to_me, per-thread topic/sentiment. **Scale = bulk deterministic pass first (seconds), then LLM-batched enrichment (20 humans per turn), not 500 sequential agent runs.**

### 1.4. The living-map layer

The map isn't built once; it compounds. Every new WhatsApp message triggers a fresh observer pass on that sender. Every founder correction in Telegram supersedes an agent guess. Every weekly cron finds title/company drift and refreshes. Nothing is "baked" — observations are append-only; projections re-derive.

### 1.5. The CLI wrapping (the thing we still need to build)

Today the agent's interface to Orbit is raw HTTP curl in prompts. That's the same mistake as making Wazowski `POST web.whatsapp.com/send` instead of using `wacli send`. Orbit needs its own CLI (`orbit person get`, `orbit observation emit --batch`, etc.) so the agent thinks at the relationship level, not the transport level.

### 1.6. Map-first, views-second

Once the map is built cleanly, **every "feature" is a query on top**: top-N by activity, going-cold, who-at-company, shared-connections, forgotten-contacts. None of those need new pipelines. The only load-bearing build is the map itself.

---

## 2. What's built, tested, and verified

### 2.1. Orbit repo (this worktree, branch `worktree-autonomous-2026-04-19`)

| Area | Files | State |
|---|---|---|
| Observation schema | `src/lib/observations-schema.ts` | 5 kinds (interaction/person/correction/merge/split), zod discriminated union, 18 unit tests green |
| Card assembler | `src/lib/card-assembler.ts` | Pure fn, latest-wins + correction-override + Jaccard-dedup summary, 8 unit tests green |
| POST `/observations` | `src/app/api/v1/observations/route.ts` (POST handler) | Batch upsert through RPC, dedup trigger, 8 integration tests |
| GET `/observations` | same file (GET handler) | Cursor-paginated read, 8 integration tests |
| GET `/person/:id/card` | `src/app/api/v1/person/[id]/card/route.ts` | Assembles card from linked observations, 6 integration tests |
| POST `/person/:id/correct` | `src/app/api/v1/person/[id]/correct/route.ts` | Writes kind:"correction" with confidence=1.0, 6 integration tests |
| DB: observations table | `supabase/migrations/20260419_observations.sql` | Applied live. BEFORE INSERT trigger computes dedup_key via pgcrypto (`extensions.digest`). RLS enabled. Append-only by contract. |
| DB: persons + links | `supabase/migrations/20260419_persons.sql` | Applied live. Random UUIDs. RLS scoped by user_id. |
| DB: `upsert_observations` RPC | `supabase/migrations/20260419_upsert_observations_rpc.sql` + `_auto_merge.sql` | SECURITY DEFINER. Auto-materializes persons + person_observation_links when a kind:"merge" row arrives. Also auto-links corrections to their target_person_id. |
| DB: read RPCs | `supabase/migrations/20260419_select_observations_rpc.sql` + `..._person_observations_rpc.sql` | SECURITY DEFINER reads. Cursor-paginated for resolver, per-person-indexed for card. |
| orbit-rules plugin | `orbit-rules-plugin/` | Node CJS/ESM plugin, 5 tools: normalize_phone, canonicalize_email, domain_class, lid_to_phone, fuzzy_match. 28 unit tests green including a real-LID lookup against a fixture session.db. |
| SKILLs for claw | `orbit-claw-skills/orbit-observer/SKILL.md`, `orbit-claw-skills/orbit-resolver/SKILL.md` | Staged locally, deployed to claw (see §3). |

### 2.2. Test suite

```
Test Files  11 passed (11)
     Tests  108 passed (108)
```

Breakdown:
- `tests/unit/sanity.test.js` — 1 (pre-existing)
- `tests/unit/raw-events-schema.test.ts` — 8 (pre-existing)
- `tests/unit/upsert-raw-events-rpc.test.ts` — 5 (pre-existing)
- `tests/integration/raw-events-endpoint.test.ts` — 5 (pre-existing)
- `tests/integration/wacli-to-raw-events.test.js` — 7 (pre-existing)
- `tests/unit/observations-schema.test.ts` — **18 new**
- `tests/unit/card-assembler.test.ts` — **8 new**
- `tests/integration/observations-endpoint.test.ts` — **16 new** (POST + GET)
- `tests/integration/person-card-endpoint.test.ts` — **6 new**
- `tests/integration/person-correct-endpoint.test.ts` — **6 new**
- `tests/unit/orbit-rules-plugin.test.mjs` — **28 new**

**Net: +82 tests this session.**

### 2.3. Commits

```
bedd1d8 fix(card-assembler): jaccard-dedupe redundant summary fragments
0fcb0f6 verify(v0-orbit): Ramon card 6/6 via fully-agentic path
a61843f feat(v0-orbit): auto-merge materializes persons + links in one POST
bd5ea54 verify(v0-orbit): Umayr card end-to-end 6/6 — first honest pass
49d534f feat(v0-orbit): observer+resolver SKILLs + plugin-entry loader fix
2da5414 feat(orbit-rules): stateless OpenClaw plugin with 5 deterministic tools
0c36ad1 feat(v0-orbit): card assembler + GET observations/card + POST correct
ef67053 feat(v0-orbit): observations basket + POST /api/v1/observations
caed49a docs(openclaw-snapshot): autonomous reconnaissance of claw VM
```

8 feature commits + 1 recon commit, 8 ahead of `main`, not pushed.

---

## 3. What's live and reachable right now

### 3.1. On Sanchay's Mac (dev)

- Dev server on `http://localhost:3047` via `./dev` wrapper (worktree-pinned PORT in `.env.local`).
- agent-browser observability dashboard on `http://localhost:4848`.
- Worktree at `/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19` on branch `worktree-autonomous-2026-04-19`.
- Tailscale hostname `192-1` at `100.97.152.84` (reachable from claw over tailnet).

### 3.2. On claw (GCP VM, openclaw-sanchay)

- `openclaw-gateway.service` healthy at v2026.4.5 — 9 plugins loaded including our `orbit-rules`.
- `~/.openclaw/plugins/orbit-rules/` — deployed, installed (`openclaw plugins install` ran cleanly).
- `~/.openclaw/extensions/orbit-rules/` — installation copy (this is what's actually loaded).
- `~/.openclaw/workspace/skills/orbit-observer/SKILL.md` + `.../orbit-resolver/SKILL.md` — deployed, discoverable.
- `~/.openclaw/.env.ORBIT_API_URL` = `http://100.97.152.84:3047/api/v1` (temp — points at dev Mac over tailnet; original Vercel URL backed up at `~/.openclaw/.env.bak.pre-dev-*`).
- `openclaw.json → plugins.entries.orbit-rules = {"enabled": true}`.

### 3.3. In Supabase (project `xrfcmjllsotkwxxkfamb`)

- `public.observations` table + BEFORE INSERT trigger + RLS + 4 indexes. 12 rows (4 interactions + 1 person for Umayr, 3 interactions + 1 person for Ramon, 1 merge each, 1 correction).
- `public.persons` — 2 rows (Umayr = `67050b91-...`, Ramon = `9e7c0448-...`).
- `public.person_observation_links` — 12 rows.
- RPCs live: `upsert_observations` (with auto-merge), `select_observations`, `select_person_observations`, `compute_observation_dedup_key`.

### 3.4. Old state preserved

- `raw_events` table (33,105 rows from the 2026-04-17 bootstrap) is **parked**. Not dropped, not migrated. Decision D in the session plan: V0 starts cold and re-observes honestly.

---

## 4. End-to-end verifications (the actual evidence)

### 4.1. Umayr Sheik (first proof)

`GET /api/v1/person/67050b91-5011-4ba6-b230-9a387879717a/card`:
```json
{
  "name": "Umayr Sheik",
  "phones": ["+971586783040"],
  "emails": ["usheik@sinxsolutions.ai", "usheik@weddingdai.com", "umayrsheik@gmail.com"],
  "company": "SinX Solutions",
  "title": "Founder",
  "category": "team"   // was "friend", corrected via POST /correct
  "relationship_to_me": "Close friend and tech peer based in Dubai. ...",
  "last_touch": "2026-04-16T16:45:57+00:00",
  "observations.total": 6,
  "observations.interactions": 4 (Feb 2025 Gmail → Apr 2026 WA)
}
```

Wazowski's summary from its session log:
> *observed seed=971586783040@s.whatsapp.net threads=4 interactions=4 persons=1 posted inserted=5 deduped=0*

Full artifact: `outputs/verification/2026-04-19-umayr-v0/`.

### 4.2. Ramon Berrios (second proof, via the auto-merge path)

`GET /api/v1/person/9e7c0448-dd3b-437c-9cda-c512dbc5764b/card`:
```json
{
  "name": "Ramon Berrios",
  "phones": ["+17874244135", "+13057974114"],  // 2 phones
  "emails": ["ramongberrios@gmail.com"],
  "company": "Wynami Inc",
  "title": "Founder",
  "category": "founder",   // different from Umayr's "team" — real discrimination
  "relationship_to_me": "Freelance client and close collaborator. Founder of Gemz (influencer marketing SaaS)...",
  "last_touch": "2026-04-16T03:06:54+00:00",
  "observations.interactions": 3 (onboarding, weekly calls, intense WA debug)
}
```

Wazowski's summary:
> *observer: threads=3 interactions=3 persons=1 inserted=4 deduped=0*
> *resolver: buckets=1 deterministic-merges=1 bridges=phone+phone+email+lid persons=1 linked-interactions=3*

**The auto-merge RPC materialized the persons row + 5 links server-side** from the merge POST. No dev-Mac assist. Full artifact: `outputs/verification/2026-04-19-ramon-v0/`.

### 4.3. Correction loop

`POST /api/v1/person/67050b91-.../correct` with `{field:"category", new_value:"team", source:"telegram"}`. Next GET: `category: "team"`. Correction stored as its own observation with `confidence: 1.0, source: "telegram"`.

### 4.4. Plugin tool calls Wazowski actually made (from session 7318f901)

- `orbit_rules_domain_class` × 5
- `orbit_rules_canonicalize_email` × 3
- `orbit_rules_normalize_phone` × 1
- `orbit_rules_lid_to_phone` × 1 (real lookup against 14,995-row `session.db`)
- `exec` (wacli + gws) × 27
- Safety drops applied: **13 bot emails** total dropped across both runs.

---

## 5. Principles we locked (memory index)

All saved under `/Users/sanchay/.claude/projects/-Users-sanchay-Documents-projects-personal-orbit/memory/`. Grouped here for quick scan:

| Memory | Essence |
|---|---|
| `project_agent_is_the_contract` | The agent is the only writer. Orbit never reads raw sources. SSH is dev scaffolding. |
| `project_v0_experiment_scope` | V0 is single-pair Sanchay↔Wazowski. Sibling agents deferred until single-pair works. |
| `project_orbit_deployment_burned` | Vercel 404s are deliberate clean slate. Not an incident. |
| `project_supabase_is_test_env` | Apply migrations + run destructive SQL without pause. Not prod. |
| `project_dev_tailnet_routing` | claw → Mac at `100.97.152.84:3047` over tailnet until Orbit redeploys. |
| `project_orbit_is_discovery_not_directory` | Target 400-600 long-tail humans, not top-30. Show the forgotten ones. |
| `project_map_first_queries_second` | Storage correctness is load-bearing. Views are cheap SQL/Cypher on top. |
| `project_scale_architecture_deterministic_first` | 80/20 split: rules do bulk phone/email/LID, agent batches LLM for category/summary/topic. |
| `project_orbit_needs_its_own_cli_plugin` | Build an `orbit` CLI same shape as wacli. Agent thinks at relationship level, not HTTP. |
| `feedback_recon_target_is_openclaw` | "Understand the data" = profile claw, not Orbit's empty stores. |
| `feedback_explain_with_concrete_examples` | Use named-human walkthroughs ("Day 1, Day 5 with Umayr") not abstract trade-offs. |
| `feedback_dogfood_before_generalize` | Works-for-Sanchay gates any multi-founder work. |

---

## 6. Next-session build order (arrived-at plan)

Prior plan file: `/Users/sanchay/.claude/plans/do-you-want-to-quiet-dragonfly.md`. Superseded in priority by this handoff.

**Goal: map Sanchay's ~500-human network, keep it living, and let him see it.**

### Phase A — `orbit` CLI plugin (the agent-facing verb surface)

Build an OpenClaw skill + binary with this surface (at minimum):

```
orbit person get <name-or-id> | --phone | --email
orbit person list [--active-30d | --going-cold | --company X | ...]
orbit person emit --json <payload> | -                # stdin-batchable
orbit person correct <id> --field X --value Y
orbit person retract <id>
orbit interaction emit --json | -                     # stdin-batchable
orbit observation bulk --file <ndjson>                # batch upload N at once
orbit observation list [--since | --kind | --limit | --cursor]
orbit resolve --seed <id> | --all
orbit search "<query>" [--limit N]                    # semantic search
orbit neighbors <id>                                  # graph traversal
orbit going-cold --days N
orbit stats | orbit doctor
```

Key capability — **bulk filter / upload / correct** explicitly. Sanchay called this out: *"bulk filtering uploading correcting all of those elements as well."* The CLI should accept NDJSON on stdin for bulk ops.

Install path on claw: `~/.openclaw/plugins/orbit-cli/`. Node CJS or ESM, `openclaw.extensions: ["./index.js"]` required (learned this the hard way — see §7).

### Phase B — Bulk scale pipeline (the 500-human map)

Two-phase as per `project_scale_architecture_deterministic_first`:

1. **Phase B1 — deterministic bulk ingest.** One script on claw (or a skill) that reads `wacli.db`, `~/.orbit-export/gmail-wide-*.messages.ndjson`, `~/.orbit-export/google-contacts-*.ndjson`. Runs rule tools in-process. Emits skeleton observations for every non-bot human. `orbit observation bulk` sends them in batches of 100. **No LLM. ~30 sec. Zero API cost.**

2. **Phase B2 — LLM enrichment in batches.** New skill `orbit-observer-enrich`. For each batch of ~20 persons (read via `orbit person list`), ask the agent to emit interpretive observations (`category`, `relationship_to_me`, per-interaction `topic`+`sentiment`+`summary`). Posts via `orbit observation emit`. ~25 turns for 500 humans. ~$3-5 Anthropic.

**Success gate:** `orbit stats` shows ~500 persons, ~1500+ observations. Random sample of 10: do 8+ look honest.

### Phase C — Continuous-update loop

Three skills + one cron:

1. **`orbit-observer-dispatcher`** — listens at `/hooks/whatsapp` (and optionally `/hooks/gmail-watch`); when a message arrives from sender S, fires observer on S. Idempotent — the dedup_key trigger silently no-ops on already-seen observations.
2. **`orbit-cards-refresh` nightly cron (3am IST)** — re-enriches the top-N stale cards (where `last_enriched_at < now() - 14d`). Catches title/company drift.
3. **`orbit person retract`** on CLI + corresponding `POST /person/:id/retract` endpoint on Orbit. Soft-delete for pruning spam/false-persons. ~30 min build.

### Phase D — Thin UI (founder-facing view)

Two views, both cheap once B is done:
- **List view**: table of all cards, sortable by name/last_touch/activity/company/category. Filter chip for going-cold/forgotten. Click a row → expand to the full card JSON.
- **Graph view**: reagraph (already in `package.json`) rendering persons + KNOWS edges from co-presence. Hover → card preview.

**~1 afternoon of work after A + B.** The data shape drives the UI, not vice versa.

### Build ordering logic

A unblocks B and C (every skill thereafter uses the CLI).
B produces the actual map.
C keeps the map alive after B is built.
D is for the founder to look at it.

**A → B → C → D. Total: ~1 week of focused work.**

---

## 7. Deliberate gaps we chose not to close this session

1. **No `POST /person/:id/retract` endpoint.** Soft-delete not built. Today would require psql. Phase C covers this.
2. **`orbit-observer-bulk` doesn't exist.** Per-turn-per-human only. Phase B covers.
3. **No continuous trigger.** Observer runs on prompt, not on inbound signal. Phase C covers.
4. **No UI.** Cards are curl-only. Phase D covers.
5. **33k `raw_events` rows are parked.** Not migrated into observations. Deliberate (Decision D in the session plan).
6. **Only 2 of the 5 topology seeds from `agent-docs/10-eda-findings.md` tested.** Missing: LID-only sender, Gmail-heavy no-WA, dormant-turned-recent. Phase B will surface these naturally.
7. **Enum drift across re-runs.** Two consecutive observer runs may classify the same interaction's topic/sentiment differently. Acceptable for V0. Mitigate with few-shot examples in the enrichment SKILL.md in Phase B2.
8. **Concurrency between observer and resolver.** V0 runs serially or in a single turn. Phase 2 would need an advisory lock or watermark — not on the critical path.

---

## 8. Open questions to resolve in next session

1. **Where does `orbit` CLI live?** A new top-level dir in the Orbit repo (`orbit-cli-plugin/`) like `orbit-rules-plugin/`? Or a separate npm package? Repo-local is simpler for V0.
2. **Does `orbit observation bulk` stream or batch?** Streaming would let the bulk ingest start updating Orbit before the local script finishes. Batching is simpler. Stream later if needed.
3. **For the UI — authenticated via Supabase session or via the API key?** The existing `getAgentOrSessionAuth` supports both. Pick one for V0 per the founder's own login flow.
4. **Does the `orbit-observer-enrich` skill write new `kind:"person"` observations (additive) or `kind:"correction"` observations (field-by-field)?** Either works — additive is simpler, correction gives a cleaner audit trail. Probably additive for V0.
5. **Persons table should have a `retracted_at` column for soft-delete vs. a hard DELETE with cascade?** Soft-delete preserves basket, better audit. Hard delete is simpler.
6. **Should the card endpoint surface `retracted` persons with `410 Gone` or `404`?** 404 is simpler; 410 is semantically more correct.

---

## 9. How to resume (commands)

From a fresh shell on Sanchay's Mac:

```bash
# 1. Go to the worktree
cd /Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19

# 2. Start the dev server (worktree-pinned port :3047)
./dev &
# (or in another terminal: ./dev)

# 3. Verify Orbit's live cards
set -a && . ./.env.local && set +a
curl -s -H "Authorization: Bearer $ORBIT_API_KEY" \
  http://localhost:3047/api/v1/person/67050b91-5011-4ba6-b230-9a387879717a/card | jq .
curl -s -H "Authorization: Bearer $ORBIT_API_KEY" \
  http://localhost:3047/api/v1/person/9e7c0448-dd3b-437c-9cda-c512dbc5764b/card | jq .

# 4. Verify claw-side plugin + skills
ssh claw 'openclaw plugins inspect orbit-rules | head -30'
ssh claw 'ls ~/.openclaw/workspace/skills/orbit-observer/ ~/.openclaw/workspace/skills/orbit-resolver/'

# 5. Trigger a fresh observer run (for any seed)
ssh claw 'timeout 300 openclaw agent --agent main --thinking medium --timeout 240 \
  --message "Execute the orbit-observer skill for seed <JID-OR-PHONE>..."'

# 6. Run tests
npm test    # expect 108 green
```

Redeploy path if any of the claw-side artifacts drift:

```bash
rsync -a --exclude node_modules orbit-rules-plugin/ claw:~/.openclaw/plugins/orbit-rules/
ssh claw 'cd ~/.openclaw/plugins/orbit-rules && npm install --omit=dev'
rsync -a orbit-claw-skills/orbit-observer/   claw:~/.openclaw/workspace/skills/orbit-observer/
rsync -a orbit-claw-skills/orbit-resolver/   claw:~/.openclaw/workspace/skills/orbit-resolver/
ssh claw 'systemctl --user restart openclaw-gateway.service'
```

---

## 10. Gotchas learned the hard way (so the next session doesn't relearn)

1. **`openclaw.plugin.json` alone isn't enough for a plugin to be discovered.** `package.json` must have `"openclaw": { "extensions": ["./index.js"] }`. Otherwise `openclaw plugins install` fails.
2. **The plugin-entry runtime bundle aliases the export as `t`.** Import via `const { t: definePluginEntry } = require(path.join(dir, file));`. Not `.definePluginEntry`.
3. **Pgcrypto's `digest()` lives in the `extensions` schema** on Supabase. Trigger functions need `set search_path = public, extensions` to see it.
4. **`raw_events` ≠ observations.** Don't back-fill from one to the other naively — the old raw events don't have `topic`, `sentiment`, `relationship_context`. Would need an LLM pass to translate. Not worth it for V0.
5. **Next.js `PORT` env needs to be in the shell at CLI invocation**, not just `.env.local`. The worktree's `./dev` wrapper sources `.env.local` before exec so it works.
6. **Skills go in `~/.openclaw/workspace/skills/`, not `~/.openclaw/skills/`**. The latter path doesn't exist.
7. **Every fuzzy-match / LLM-classified field should carry its own `confidence` in the observation envelope.** Card assembler can then filter or weight by confidence at read time. We already do this; don't break the convention.

---

## 11. Related artifacts (where to look for depth)

- `/Users/sanchay/.claude/plans/do-you-want-to-quiet-dragonfly.md` — the approved plan file from Phase 2 design.
- `agent-docs/10-eda-findings-2026-04-19.md` — pre-session data recon, the topology seeds, Umayr's original dossier.
- `agent-docs/02-architecture.md` — the three-contracts framing (read if any architectural drift).
- `outputs/verification/2026-04-19-umayr-v0/` and `2026-04-19-ramon-v0/` — per-human scorecards + card.json + basket.txt.
- `outputs/verification/2026-04-19-umayr-v0/SESSION-SUMMARY.md` — a shorter prose summary of what landed this session.
- `outputs/verification-log.md` — the canonical PASS row for the V0 Umayr run.
- `openclaw-snapshot/reports/00-synthesis.md` — the recon synthesis from earlier in the session (what OpenClaw is, what Orbit fits into).

---

## 12. One-line resume for a new chat

> "The V0 observer → resolver → card pipeline works end-to-end on 2 real humans (Umayr, Ramon, 6/6 scorecard each), 108 tests green, 8 commits on `worktree-autonomous-2026-04-19`. Next session: build the `orbit` CLI plugin, run bulk ingest to map Sanchay's ~500-human network, wire the continuous-update loop, add a thin UI. Read `agent-docs/11-v0-pipeline-handoff-2026-04-19.md` first."
