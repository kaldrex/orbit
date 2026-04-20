# 07 · Historical Docs Delta (11, 12, 13)

Cross-checked against 14 (cleanup), 15 (future-props), 16 (how-it-works-end-to-end), 17 (resilient-worker). Only the *additions* — the specifics the newer docs summarize or omit.

---

## Doc 11 delta (V0 pipeline handoff, 2026-04-19)

Doc 11 is the single best narrative source for **why the V0 architecture is shaped the way it is**. 14/15/16/17 give the *current* shape; 11 gives the *reasons* and the invariants.

### Load-bearing architecture decisions still shaping current code

1. **The observer → basket → resolver → card pipeline as four discrete stages.** Doc 11 §1.1–1.6 is the only place this pipeline is decomposed by *role*: observer reads channels and emits raw observations; basket (`observations` table) is append-only with dedup_key; resolver does union-find over bridges and writes `kind:"merge"` rows; card assembler is a pure read-time function. This is why `src/lib/card-assembler.ts` is a pure function (not a materialized view) and why the `upsert_observations` RPC has auto-merge baked into it server-side (§3.3 "auto-materializes persons + person_observation_links when a kind:'merge' row arrives"). Later docs describe the pieces but don't motivate the separation.

2. **CLI-is-plumbing invariant, explicitly stated.** §1.5: *"The `orbit` CLI owns arg parsing, HTTP transport, batching, auth, and output formatting — nothing else. All LLM judgment... stays inside the observer/resolver SKILLs and runs in Wazowski's prompt turn, funded by Wazowski's token budget. The CLI binary never holds an `ANTHROPIC_API_KEY`; it replaces curl, not the skill's brain. If a proposed verb seems to need judgment, push that work back into a SKILL.md instead of teaching the CLI to think."* This is the charter for `orbit-cli-plugin/`'s 4 pure-plumbing verbs. It's the source of the rule 7 in CLAUDE.md.

3. **Bulk-vs-incremental split (80/20 deterministic vs LLM).** §1.3: *"~80% of card-building work is deterministic and doesn't need an LLM — phone normalization, email canonicalization, LID→phone bridge, bot filtering, dedup, bridge-based merges. ~20% is interpretive... Scale = bulk deterministic pass first (seconds), then LLM-batched enrichment (20 humans per turn), not 500 sequential agent runs."* This is *why* the Stage 5/5c bulk ingest (1,600 skeleton persons) was done before Stage 6 (LLM enrichment) — the split was decided architecturally, not discovered during cleanup.

4. **Five observation kinds as a closed set.** §2.1: "5 kinds (interaction/person/correction/merge/split), zod discriminated union." 14/15/16 mention `interaction` and `correction` in flow examples but don't enumerate the closed set. The zod discriminated union in `src/lib/observations-schema.ts` is the contract that makes the auto-merge RPC safe — it knows exactly which kinds to materialize persons for.

5. **`raw_events` table is parked, not migrated.** §3.4 + §7.5 + §10.4: *"33k `raw_events` rows are parked. Not migrated into observations. Deliberate (Decision D)."* Reason: raw events lack `topic`/`sentiment`/`relationship_context` — translating would need an LLM pass per row. 14/15 mention raw_events exists but don't explain *why* it's not the source of observations.

6. **Gotchas (§10) that are silently baked into current code:**
   - `openclaw.extensions: ["./index.js"]` required in package.json (plain `openclaw.plugin.json` is insufficient)
   - Plugin-entry bundle aliases export as `t` → `const { t: definePluginEntry } = require(...)`
   - `pgcrypto.digest()` lives in `extensions` schema on Supabase → triggers need `search_path = public, extensions`
   - Skills path is `~/.openclaw/workspace/skills/`, NOT `~/.openclaw/skills/`
   - Every fuzzy/LLM field carries its own `confidence` in the observation envelope

### Open questions from §8 that never got an answer in later docs

- Does `orbit observation bulk` stream or batch? (Appears to have landed as batch.)
- UI auth — Supabase session vs API key? (Still open; `getAgentOrSessionAuth` supports both.)
- `orbit-observer-enrich` SKILL: additive `kind:"person"` observations vs field-by-field `kind:"correction"`? (Unresolved.)
- Persons soft-delete (`retracted_at`) vs hard DELETE? (Unresolved; doc 11 §7.1 flags no retract endpoint exists.)
- Card endpoint for retracted persons: `410 Gone` vs `404`? (Unresolved.)

---

## Doc 12 delta (junk filtering)

Layer 1 (rules) and Layer 3 (heuristic annotations) shipped. **Layer 2 — agent-mutable blocklist — is entirely future.** Doc 12 is the only place its design lives.

### Layer 2 schema (not yet in any migration)

```sql
CREATE TABLE blocklist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) NOT NULL,
  kind text NOT NULL,
  -- 'email' | 'email_pattern' | 'domain' | 'name' | 'name_pattern'
  -- | 'group_jid' | 'group_name_pattern'
  pattern text NOT NULL,
  reason text NOT NULL,
  source text NOT NULL,     -- 'manual' | 'agent' | 'heuristic'
  added_by text NOT NULL,   -- email | 'wazowski' | heuristic name
  confidence numeric NOT NULL, -- 0.0-1.0
  active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE blocklist ENABLE ROW LEVEL SECURITY;
CREATE POLICY blocklist_user_scope ON blocklist USING (user_id = auth.uid());
CREATE INDEX blocklist_lookup ON blocklist (user_id, kind, active);
```

RLS-scoped by user_id, same model as observations/persons.

### CLI verbs Layer 2 requires (not yet built)

Manual (Sanchay):
- `orbit block-email <email> --reason "..."`
- `orbit block-name "<name>" --reason "..."`
- `orbit block-group <jid> --reason "..."`
- `orbit unblock-email <email>`
- `orbit blocklist list [--kind=... | --source=...]`

All POST to a new `/api/v1/blocklist` route (also not yet built).

Agent-autonomous (Wazowski, only when `confidence ≥ 0.9`):
- `orbit_block_email({email, reason, confidence})`
- `orbit_block_group({group_jid, reason, confidence})`
- `orbit_block_name({name, reason, confidence})`

### When Layer 2 fires

Three runtime read-paths must consult it:
1. **manifest-gen** on startup: `SELECT * FROM blocklist WHERE user_id = $1 AND active = true`, builds in-memory sets (exact) + regex arrays (patterns). Every bucket checks before emit.
2. **observer SKILL** adds a pre-emit step: call `orbit_blocklist_get()` once per run, apply the same checks.
3. **Orbit API `/observations` POST**: cross-reference before accept; on match → `409 Conflict` echoing the matching entry so the caller knows why.

### Self-writing heuristic entries (the seed cases)

**Group heuristics** (today's gap per §Layer 3 shipped):
- Members > 200 AND Sanchay's outbound = 0 → `group_jid`, `added_by='mega-lurker'`, confidence 0.85
- Single sender > 80% of messages → `group_jid`, `added_by='broadcast-detector'`, confidence 0.9
- Name matches `sale|deal|offer|crypto|giveaway|coupon|promo|discount` → `group_name_pattern`, `added_by='commercial-keyword'`, confidence 0.8

**Email heuristic:**
- Sender sends >50 messages, <5 personalized, same template shape → `email` block, `added_by='template-detector'`

### Lifecycle

Run → heuristics write entries at 0.8–0.9 confidence → Wazowski adds at ≥0.9 during observer runs → Sanchay reviews weekly (`orbit blocklist list --source=heuristic --confidence-lt=0.95`), promotes to 1.0, demotes (active=false), or leaves alone.

### Open decisions in Layer 2

1. Should agent blocks require Sanchay approval within 7 days else auto-revert? (Safety-against-LLM-drift question.)
2. Should heuristic entries auto-expire if they match nothing for 90 days?
3. Do we version the blocklist schema so old manifests can be re-generated against the blocklist state at that time? (Time-travel reproducibility.)

---

## Doc 13 delta (multi-tenant onboarding — Hardeep/chad)

### What's already done (from the 2026-04-20 cleanup)

- **RLS wired** on `observations`, `persons`, `person_observation_links`, (and future `blocklist`) — `USING (user_id = auth.uid())`. No code changes needed at the DB layer to add a new founder.
- **`ORBIT_SELF_EMAIL` / `ORBIT_SELF_PHONE` hardcode-removal shipped** — per §"Code changes required" and the DONE 2026-04-20 note: `manifest-gen.mjs` now fail-fasts if these env vars are unset. That was the "one hardcode" blocker, now gone. See 14 §Phase B5.

### What's NOT implemented

1. **API key minting UI.** Today it's ad-hoc `INSERT` into `api_keys`. Production needs an admin page to mint, scope to user_id, set `name` + `expires_at`.
2. **npm-published plugins.** Install path today is `git clone + cp -r` onto the new founder's claw. Future is versioned npm packages (`orbit-rules-plugin`, `orbit-cli-plugin`).
3. **Second founder actually onboarded.** Gated by `feedback_dogfood_before_generalize.md` — Hardeep/chad don't get pulled in until the Sanchay/Wazowski single-pair fully works.

### The concrete 9-step onboarding runbook (doc 13 is the only place this exists in full)

1. Orbit account signup (2 min) → auth.users row → API key `orb_live_deep_xxxxx`.
2. OpenClaw install on Deep's laptop/VM (~30 min, curl + systemctl).
3. Channel auth: `wacli auth` QR + `gws auth` OAuth (15 min).
4. Plugin install via `git clone + cp + npm install --omit=dev + openclaw plugins install` (~10 min, admin).
5. `~/.openclaw/.env` gets `ORBIT_API_URL`, `ORBIT_API_KEY`, `ORBIT_SELF_EMAIL`, `ORBIT_SELF_PHONE` (2 min).
6. Rsync skills to `~/.openclaw/workspace/skills/` + restart gateway (5 min).
7. First observer run against one known seed (5 min).
8. Bulk ingest via `manifest-gen.mjs` → `manifest-to-observations.mjs` → `orbit_observation_bulk` (~30 min).
9. LLM enrichment batched 20/turn, paid from Deep's OpenClaw budget (~$5, half day overnight).

Total: **~1 working day end-to-end** from signup to "live, enriched map."

### Cost per founder (not stated elsewhere)

| Component | $/founder/month |
|---|---|
| Supabase | ~$0 marginal (shared Pro) |
| Vercel | ~$0 marginal |
| Anthropic — enrichment | ~$5 initial + ~$2 steady |
| Anthropic — OpenClaw runtime | ~$20–50, paid by founder |

V0 scale assumption: **~6–10k humans per founder** (doc 13 number; doc 11 used ~500 for Sanchay specifically).

### Open questions in doc 13

1. Shared blocklist across founders (opt-in) — cross-linked to doc 12 "Future."
2. Per-founder orbit-cli install vs symlink — npm registry path resolves.
3. Aggregate telemetry without content access — needs a materialized view (RLS hides content).
4. "Bring your own DB" self-host path for founders wanting their own Supabase project.
5. Billing — who pays Anthropic; is enrichment metered per founder?

---

## Contradictions with 14/15/16/17

1. **Person count.** Doc 11 §2.1 claims "2 real humans verified" + "observations: 12 rows pre-cleanup." 14 supersedes: 1,602 persons, 3,218 observations post-Stage-5c. Doc 11's banner already flags this.
2. **Test count.** Doc 11 says "108 tests green." 14/current CLAUDE.md say **329 across 19 files**. Doc 11 banner acknowledges.
3. **API routes.** Doc 11 §2.1 lists 4 routes (observations GET/POST, person card, person correct). Current (CLAUDE.md) is **5 live + `persons/enriched`** — the `GET /api/v1/persons/enriched` + `select_persons_page` RPC both landed 2026-04-20 after doc 11.
4. **CLI status.** Doc 11 treats the `orbit` CLI as future (Phase A). 14/15 confirm `orbit-cli-plugin/` **exists with 4 verbs** (`orbit_observation_emit`, `orbit_observation_bulk`, `orbit_person_get`, `orbit_persons_list_enriched`). The CLI-is-plumbing invariant survives intact — the verb surface was kept narrow.
5. **Proposed CLI verbs in doc 11 §Phase A are aspirational, not current.** Doc 11 lists ~15 verbs (`orbit resolve`, `orbit search`, `orbit neighbors`, `orbit going-cold`, `orbit stats`, `orbit doctor`, `orbit interaction emit`, etc.). Today only 4 are shipped; the rest are still future (and not all will land — e.g., semantic `orbit search` likely turns into a SKILL call, not a CLI verb, to keep the plumbing-only invariant).
6. **Junk filtering state.** Doc 12's Layer 1 "shipped" claim is corroborated by 14 (10 modules in `orbit-rules-plugin/lib/`). Doc 12's Layer 3 "partially shipped" (annotations, not blocklist writes) is accurate. No contradiction — just progression.
7. **Raw events.** Doc 11 says parked. Nothing in 14/15/16/17 has migrated or un-parked it. Still parked.

---
