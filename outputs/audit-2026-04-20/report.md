# Orbit — State-of-the-Project Audit · 2026-04-20

Auditor: Claude Opus 4.7 (read-only pass, no code/data mutations).
Scope: worktree branch `worktree-autonomous-2026-04-19` at commit `a351f69`, Supabase project `xrfcmjllsotkwxxkfamb`, memory + agent-docs as of 2026-04-19 session end.

---

## Overall grade: **B- (solid plumbing, thin data quality, heavy doc drift)**

Three-line summary:

1. The code you shipped this session (two plugins, three verbs, 196 tests) is the best-engineered surface in the repo — error taxonomy is crisp, tests cover the CLI thoroughly, rules layer is tight. Keep this bar.
2. The data you put into Supabase is **not** the same quality as the code that could produce it: 99.97% of persons are `category:other` placeholders, 74% carry a phone as their name, and the DB was loaded from manifest **v2 (buggy)** while the "fixed" **v3** was only fed into the viz. There is a silent divergence between what the viz shows and what the API returns.
3. Documentation fidelity is the weakest dimension — CLAUDE.md still claims "3 routes / 26 tests / raw_events is source of truth," `03-current-state.md` is pre-observations, the README index omits docs 12 and 13, and handoff §3.3 says "2 persons" when the DB has 6,809. Anyone opening the project cold will read lies before they read truth.

---

## Findings by dimension

### 1. Code quality

**🔴 critical · `orbit-cli-plugin/index.js:70-71,99-100,118-119` — `resolveConfig()` throws, breaking the error-envelope contract.**
`lib/client.mjs` promises at line 2-4: *"no retries … every function returns a plain object; HTTP failures come back as `{error: {...}}` not thrown."* But `index.js` calls `resolveConfig()` synchronously in every tool's execute wrapper, and `env.mjs:15-16` throws `new Error("ORBIT_API_URL is not set")`. If the env is unset, the agent gets an uncaught exception instead of an `{error: {code: "INVALID_INPUT"}}` envelope. The client functions also re-invoke `resolveConfig()` after config is passed in, so the defensive path exists but is dead-coded behind a passthrough. Fix: shape missing-env as `invalidInputError("ORBIT_API_URL / ORBIT_API_KEY not set")`.

**🟠 high · `outputs/stage-5b-merges-2026-04-19/generate-merges.mjs:120` — `merged_observation_ids: [row.id, row.id]` workaround has no TODO tag.**
The comment at lines 7-9 and 117 is honest and detailed, but there's no `// TODO:` or tracking issue. `mergePayloadSchema` in `src/lib/observations-schema.ts:87` enforces `.min(2)` on what should semantically be a set. Either (a) change the schema to `.min(1)` and document that a single-observation merge is a valid "promotion," or (b) make the generator emit the base person observation + a synthetic twin. Today the ledger has 6,807 rows whose payload is mathematically misleading.

**🟠 high · `scripts/manifest-to-observations.mjs:25-28` — hard-coded to `v2` (pre-fix) manifest.**
Line 27: `INPUT = resolve(REPO_ROOT, "outputs/fixes-applied-2026-04-19/orbit-manifest-v2.ndjson")`. The fixed v3 lives at `outputs/manifest-hypothesis-2026-04-19/orbit-manifest-v3.ndjson` and was never ingested. **Result: DB persons were built from 408 raw `@g.us` JIDs in `groups[]`, while the viz reads v3 with only 37.** This is the concrete source of the "viz looks better than the cards will" risk. No comment signposts that the version is a footgun.

**🟠 high · `scripts/manifest-to-observations.mjs:48-52` — falls back `m.name → email → phone → "Unknown"` without honoring observer SKILL safety rules.**
The observer SKILL at `orbit-claw-skills/orbit-observer/SKILL.md:142-146` explicitly says reject phone-as-name (`^\+?\d{6,}$`) and email-as-name (`.+@.+`). The bulk transformer bypasses that and writes both as `name`. Real-world impact, from the DB: 5,028 phone-as-name rows, 62 email-as-name, 109 Unicode-masked-phone-as-name, 5 quoted-literal names (e.g. `'Sarmista'`), 1 test-data leak (`apitest.lead@example.com`). These all passed zod because `personPayloadSchema.name` is `z.string().min(1).max(256)` — the schema doesn't constrain shape.

**🟡 medium · `outputs/manifest-hypothesis-2026-04-19/manifest-gen.mjs:31` — hard-coded self-email.**
`const SELF_EMAILS = new Set(["sanchaythalnerkar@gmail.com"]);` Single-tenant blocker; already noted in memory (`project_v0_experiment_scope.md`) as a "15-minute fix" for Hardeep/chad onboarding. Good that it's tracked; flagging because `agent-docs/13-multi-tenant-onboarding.md:87` already shows the replacement pattern — gap is small and closable.

**🟡 medium · `outputs/stage-5b-merges-2026-04-19/generate-merges.mjs:25` — hard-coded `USER_ID`.**
Multi-tenant blocker of the same class as the self-email. The docstring at top of the file frames this as a one-shot script, but there's no guard ("if you're running this for a second tenant, read X"). If a second founder comes online before this is parameterized, the next operator may ship their data into Sanchay's user_id silently.

**🟡 medium · `orbit-cli-plugin/lib/schema.mjs:1-5` — "kept in sync manually" schema mirror.**
The mirror currently matches `src/lib/observations-schema.ts` byte-for-byte at the types level, but there's no CI check that notices if the canonical schema drifts. One obvious safety net: a unit test that imports both and compares enum arrays. Cheap to add.

**🟡 medium · `orbit-cli-plugin/lib/errors.mjs:60, client.mjs:336` — 429 `Retry-After` header is deliberately ignored.**
Consistent with the "log-first, retry-never" rule in `CLAUDE.md:50`, so this is a policy finding not a bug. Flagging because the docstring for `RATE_LIMITED` says *"Back off and retry after 60s"* (suggestion field at errors.mjs:73) — the 60s hint is a magic number pulled from nowhere. Either cite the actual response header or drop the specifics.

**🟢 low · `orbit-rules-plugin/lib/forwarded.mjs:75-82` — wrap-match regex accepts single-word left sides like `"Stripe on behalf of Stripe"`.**
Minor: the current regex `^(.+?)\s+(?:via|on behalf of|...)\s+.+$` would yield `"Stripe"` from both sides of an edge case where the vendor name appears twice. In corpus this is a non-issue but for future Slack / Zendesk-forwarded threads it's worth noting.

**✅ good · `orbit-cli-plugin/lib/client.mjs:131-165` — isolate-on-400 behavior is correctly scoped.**
Only retries per-line when the server returns 400 (shape rejection), explicitly NOT on 5xx / 429 / auth. Comment at 336-337 is crisp: "5xx / 429 / auth → whole-batch failure, no retry-to-split." This is the right call and matches the log-first policy.

**✅ good · `orbit-rules-plugin/lib/bridge.mjs:102-104, 155-163` — guardrails against false cross-channel merges.**
The "multi-token but must share ≥2 tokens" rule (lines 155-163) is a specific defense against the "Umayr Sheik + Umayr Khan" failure mode and is called out in-code. `isGenericName` covers SaaS vendor collisions. Thoughtful hand-crafted rules, not a ML fever dream.

**✅ good · Error taxonomy in `orbit-cli-plugin/lib/errors.mjs`.**
12 codes, explicit, frozen, with a suggestion string per code. The agent can pattern-match `error.code` without parsing English. Keep.

---

### 2. Data quality

**🔴 critical · The DB was ingested from the wrong manifest version.**
`outputs/fixes-applied-2026-04-19/orbit-manifest-v2.ndjson` contains **408 raw group-JID leaks** (`120363…@g.us`). `outputs/manifest-hypothesis-2026-04-19/orbit-manifest-v3.ndjson` has **37** — a 91% reduction that never made it to Supabase. The viz at `outputs/visualization/` uses v3; `observations` rows were written from v2. **The founder looking at the viz sees a different reality than the one the API will serve.** Re-ingest is required before any UI work or LLM enrichment.

**🔴 critical · 99.97% of persons are enrichment-placeholders.**
DB state:
- `kind='person'` rows: **6,809**.
- `payload.category = 'other'`: **6,807** (99.97%).
- `payload.relationship_to_me` begins with `"Appears in … threads across … channels. Pending enrichment."`: **6,807** (100% of the bulk cohort).
- Only 2 rows (Umayr, Ramon) have real categories (`friend`, `founder`).

The placeholder string contains structural data (`"Appears in 0 threads across 1 channels"`) — half the bulk has `0 threads`, suggesting a thread_count=0 case the transformer isn't skipping.

**🔴 critical · Umayr and Ramon are duplicated in DB.**
Same phones (`+971586783040`, `+17874244135`, `+13057974114`) each appear across two distinct `person_id`s:
- `67050b91-…` = "Umayr Sheik", category=friend (Stage-3 fixture), ingested 2026-04-19 08:27 UTC.
- `0e021230-…` = "Umayr", category=other (Stage-5 bulk), ingested 2026-04-19 16:39 UTC.
- `9e7c0448-…` = "Ramon Berrios", category=founder (Stage-3 fixture).
- `813c8664-…` = "Ramon B", category=other (Stage-5 bulk).

The merge-generation step should have detected the deterministic phone bridge and unified. It didn't, because each Stage-5 merge observation has `deterministic_bridges` but no lookup against pre-existing persons. The resolver has a blind spot for the "start cold + we already seeded" case.

**🟠 high · 74% of persons carry a non-human-name in the name field.**

| name_type | count | % |
|---|---|---|
| `^\+[0-9]+$` (bare E.164) | 5,028 | 73.8% |
| real-looking name | 1,605 | 23.6% |
| `+91∙∙∙…` Unicode-masked phone | 109 | 1.6% |
| email-as-name | 62 | 0.9% |
| typographic-quoted name (`'Xxx'`) | 5 | 0.07% |

The Unicode-masked-phone case (`+91∙∙∙∙∙∙∙∙42`) was flagged during Proxima Mumbai recon but the rule was never coded. Tracked nowhere in memory.

**🟡 medium · 30 humans silently skipped due to unbridgeable LIDs.**
`outputs/stage-5-bulk-ingest-2026-04-19/skipped.ndjson` has 30 rows, all `reason:"zero_identifiers"`, all with an LID but no resolvable phone/email. Among them: two separate "Hardeep Gambhir" rows (LIDs `10307938324603:28` and `10307938324603:30` — suffixes suggesting wa-channel thread variants), even though the canonical Hardeep record resolved fine. This isn't a data-loss emergency, but it's 30 humans the map claims don't exist.

**🟡 medium · 1 test-data leak in production ledger.**
`apitest.lead@example.com` shipped into `observations` as a person record (thread_count=5). Either the WhatsApp fixture DB or an integration-test artifact bled into real ingest. Low volume, low cost to remove, but symptomatic of not gating ingest by "is this actually a real sender."

**🟡 medium · The manifest `name` field is null 74% of the time.**
`orbit-manifest-v3.ndjson`: 5,090 of 6,837 rows have `"name": null`. Every one of those becomes a phone-as-name or email-as-name in the DB via the fallback ladder. The root cause is in the manifest generator's identity waterfall — WA-contact `push_name` / `full_name` are present for many more than 1,747 humans; they aren't being captured at manifest-gen time.

**🟢 low · Top 20 group names all look clean.**
Top groups in v3 include "General Chat", "Code Samaaj - Talent", "Forsage.busd.io (Busd marketing)", "Proxima Mumbai", "IAFF support and Volunteers" — all legit. Bug is confined to the 37 JID leaks (0.5% of v3). The v2→v3 group-resolution fix works; it just hasn't been applied to the DB.

**✅ good · Every DB person has at least one contact identifier.**
Zero rows with `phones=[] AND emails=[]`. The zero-identifier filter at `scripts/manifest-to-observations.mjs:107-118` is doing its job.

---

### 3. Test coverage

**🔴 critical · No tests for three load-bearing scripts.**
- `scripts/manifest-to-observations.mjs` (141 lines) — the thing that wrote 6,807 rows into prod.
- `outputs/stage-5b-merges-2026-04-19/generate-merges.mjs` (156 lines) — ditto.
- `scripts/build-network-viz.mjs` (181 lines) — the thing the founder actually looks at.

All three were run in anger, none have a test. The "v2 vs v3" bug in the transformer is exactly the class a 5-line smoke test would have caught: *"given this manifest line, assert obs.name is not the phone."*

**🟠 high · `outputs/manifest-hypothesis-2026-04-19/manifest-gen.mjs` (922 LOC) is untested.**
This is the largest piece of code in the session. Group-name resolution, union-find across sources, self-exclusion, LID bridging — all load-bearing for data quality, all landing 6,837 records, zero unit coverage. A fixture-based golden test would pay for itself the first time a rule changes.

**🟠 high · No test for the 429 `Retry-After` ignored-by-design policy.**
`orbit-cli-plugin/lib/errors.mjs:60` treats 429 as a non-retryable envelope, but there's no test asserting that — meaning a well-meaning future refactor could silently add retry logic. Add a test: "GIVEN fetch returns 429, ASSERT client returns `{error: {code: 'RATE_LIMITED'}}` and does NOT re-invoke fetch."

**🟠 high · No test for `resolveConfig()` throwing at index.js boundary.**
Covers the critical bug above. A simple *"WHEN ORBIT_API_URL is unset THEN orbitObservationEmit returns {error: ...}"* would catch the contract mismatch.

**🟡 medium · Regression tests use synthetic inputs, not the real failure data.**
`tests/unit/orbit-rules-plugin.test.mjs` has "Umayr Sheik + Umayr Khan" as an anti-merge test, but the Proxima Mumbai case that exposed Unicode-masked phones has no equivalent fixture. Golden regression tests should include real names/phones/LIDs (scrubbed or not, since this is a single-tenant repo) that previously passed and shouldn't re-regress.

**✅ good · 196 passing tests, 0 skipped, 0 `.todo`.**
No dead tests hiding in the suite. `grep -r "\.skip\|\.todo\|xit\|xdescribe"` returns zero hits. Suite runs in ~22s.

**✅ good · CLI plugin is thoroughly tested.**
`tests/unit/orbit-cli-plugin.test.mjs` is 970 lines, 64 tests. Covers happy path, all 12 error codes, dry_run modes, empty file, UUID validation, isolate-on-400 per-line retry, parse errors in NDJSON. This is the standard to apply to the scripts that write data.

---

### 4. Architectural discipline

**✅ good · `project_cli_is_plumbing` — held.**
Grepped for `anthropic`, `claude`, `openai`, `zod.describe` in `orbit-cli-plugin/`; only `zod` import is present. No LLM, no classification logic, no judgment calls. The sole piece of logic beyond transport is zod pre-validation, which is the right thing. Discipline preserved.

**🟠 high · `project_api_is_only_writer` — breached by Stage-5b generator.**
`outputs/stage-5b-merges-2026-04-19/generate-merges.mjs:33-37` opens a direct `pg.Client` to Supabase. Line 60-68 issues a `SELECT` (read-only — OK). But it's a direct DB connection outside the three contracts. If a future refactor slips an `INSERT` into that file, nothing stops it. The file is also co-located under `outputs/` rather than `scripts/`, which suggests one-shot status, but it ran in production against the real DB. Consider moving to `scripts/` and adding a top-comment: "SELECT-only. Never INSERT from here."

**🟢 low · `project_scale_architecture_deterministic_first` — held, with one footnote.**
The 80/20 split is visible: `manifest-gen.mjs` + `manifest-to-observations.mjs` = deterministic; category/relationship_to_me are placeholders awaiting LLM. **Footnote**: the LLM enrichment lane doesn't exist yet, and the placeholder strings look enough like real data ("Appears in 2 threads across 3 channels.") that a UI would render them as if they were enrichments. That's a UX failure mode waiting to happen.

**✅ good · `project_agent_is_the_contract` — held.**
No non-agent writer code in the tree. Admin flows (signup, API-key mint) are via the Next.js app + Supabase Auth. Observer SKILL uses the CLI, not curl (verified in SKILL.md:37-40).

---

### 5. Documentation fidelity

**🔴 critical · `CLAUDE.md:9-13, 21, 31` — three factual drifts in the top-level doc.**
- Line 9-13 claims 3 routes (`raw_events`, `packet`, `observation`). Actual routes: `raw_events`, `observations`, `person/:id/card`, `person/:id/correct` (4 routes, different names).
- Line 15: "One table (`raw_events`) is source of truth." Now there are 6 tables; `raw_events` is parked, not canonical.
- Line 21 + 31: "26 tests green", "expect 26 passing". Actual: 196.

Any agent opening the project and reading CLAUDE.md first is starting from a falsified map.

**🔴 critical · `agent-docs/03-current-state.md` — entire file is pre-observations.**
- Line 9-11: "Two routes. That's it."
- Line 13-14 table lists only `raw_events` + `auth/callback`.
- Line 32: "Five test files, 26 tests".
- Line 51-54 data state omits `observations`, `person_observation_links`, `persons`.
- The README does warn at line 26 ("outdated on routes/DB — see doc 11 for current"), but the doc itself doesn't have a "STALE" banner. Either repair or stamp.

**🟠 high · `agent-docs/11-v0-pipeline-handoff-2026-04-19.md:126-132` — §3.3 is pre-Stage-5.**
- Line 128: "12 rows (4 interactions + 1 person for Umayr, …)". Actual: 13,626 observations.
- Line 129: "`public.persons` — 2 rows". Actual: 6,809.
- Line 130: "`public.person_observation_links` — 12 rows". Actual: 13,625.

The doc was accurate at time of writing; Stage 5 ran after. No changelog entry appended.

**🟠 high · `agent-docs/README.md` — index omits docs 12 and 13.**
Lines 21-32 table lists only through doc 11. The two design docs written this session aren't discoverable from the index. Anyone following the "start here" path will miss the junk-filtering + multi-tenant designs entirely.

**🟡 medium · `agent-docs/12-junk-filtering-system.md:21` — "173 tests green" is stale.**
Actual count: 196. One-line fix.

**🟡 medium · `agent-docs/12-junk-filtering-system.md` — describes system that is ~40% built.**
Layer 1 (deterministic rules) exists in `orbit-rules-plugin/`. Layers 2 (blocklist table) and 3 (self-writing heuristics) are design only — no SQL migration, no code. The doc uses present tense throughout ("manifest-gen … consults at runtime") which reads as "built" to a cold reader. Needs a "Status" section at the top.

**🟡 medium · `agent-docs/13-multi-tenant-onboarding.md` — describes flow that can't run today.**
Step 4 (install plugins on Deep's machine) is doable. Step 1 (sign up via `/signup`) needs an API-key mint UI that doesn't exist; Step 5's `ORBIT_SELF_EMAIL` env-var is referenced but the code still hardcodes the email at `manifest-gen.mjs:31`. So the doc is a real design but not an executable runbook. Mark as "target state."

**🟢 low · `outputs/verification-log.md` — missing Stage 4, 5, and 5b entries.**
The verification-log discipline (CLAUDE.md §1 non-negotiable #1: "no claim without evidence") was followed through Stage 3. Stages 4 / 5 / 5b ran but weren't logged. Given the critical data-quality findings above, a log entry for Stage 5 would make the "this is placeholder data, not enrichment" footnote official.

---

### 6. Hidden debt

Status of items flagged in the prompt:

| Item | Tracked? | Location |
|---|---|---|
| `ORBIT_SELF_EMAIL` env var replacement | tracked | `project_v0_experiment_scope.md` |
| Extending bot-localpart regex for Unicode-masked phones | **invisible** | Not in memory, not in `agent-docs/`, not in any TODO. Only trace is 109 DB rows. |
| `messages.sender_name` fallback | **invisible** | Not referenced anywhere. |
| Group-junk heuristics (mega-lurker, broadcast-ratio, commercial-keyword) | partial | In `12-junk-filtering-system.md:82` as design; not in a code TODO. |
| Curation CLI verbs (`orbit block-email`, etc.) | partial | In doc 12 design; no tracking issue. |
| CI / monitoring | **invisible** | No mention in memory, agent-docs, or TODO comments. |
| API key minting UI | tracked | `project_v0_experiment_scope.md` |
| Observability for `openclaw agent --verbose --json` | **invisible** | Only in `outputs/stage-4-smoke-2026-04-19/summary.json:caveats`. Not in memory, not in handoff §7. |
| `merged_observation_ids: [id, id]` workaround | partial | In-code comment only; no TODO tag, no schema-fix plan, no issue. |
| Ramon/Umayr duplicate persons (Stage-5 collision) | **invisible** | Not flagged anywhere; discovered during this audit. |
| Manifest v2→v3 reingest required | **invisible** | Not flagged; discovered during this audit. |

**Six of eleven items are invisible.** If Sanchay walks away for two weeks, the Unicode-masked-phone bug, the Ramon/Umayr duplicate, and the v2/v3 DB/viz split will all come back as "why is the map broken?" surprises.

---

## What to preserve

1. **The error-taxonomy pattern in `orbit-cli-plugin/lib/errors.mjs`.** 12 codes, frozen object, one `suggestion` per code, zod-issue unwrapping. Replicate this shape when building the resolver skill's outputs and any future curation CLI verbs.

2. **The "pure plumbing" discipline in the CLI.** No LLM, no judgment, validation-then-transport. `orbit-cli-plugin/package.json:6` and plugin manifest both state this explicitly. Push back on any verb that wants to "just classify this one thing before sending."

3. **Test density in `tests/unit/orbit-cli-plugin.test.mjs` (64 tests, 970 LOC).** 5× the LOC of the thing it tests. That's the right ratio for plumbing that holds real data.

4. **Cross-channel name-bridge guardrails in `orbit-rules-plugin/lib/bridge.mjs:102-163`.** `isGenericName` (SaaS vendors, short tokens, blocklist), multi-token 2-shared-tokens rule, provSet shape-tolerance. Every one of those rules is a real observed failure turned into a hand-crafted defense. Resist the "let's put an LLM in here" pressure — the hand-crafted rule is doing what it should.

5. **The append-only + merge-observation contract.** Even with the `[id, id]` workaround, the data model stays honest: persons are derived, observations are immutable, corrections supersede by time. When enrichment lands, it slots in as more observations without rewriting history.

6. **The 80/20 deterministic/interpretive split as stated in `project_scale_architecture_deterministic_first.md`.** The split is real, the placeholder is honest (`relationship_to_me` literally says `"Pending enrichment."`). Don't short-circuit this by enriching inside the bulk transformer.

---

## Prioritized follow-up (top 10 by severity × effort)

| # | Item | Severity | Effort | Notes |
|---|---|---|---|---|
| 1 | Re-ingest manifest v3 over v2 (wipe bulk rows, re-run) | critical | 30 min | Fixes 408→37 JID leaks and breaks the viz/DB divergence. |
| 2 | Detect + merge pre-existing persons on bridge match | critical | 2-3 hr | Fixes Ramon/Umayr duplicates. Should check deterministic_bridges against existing persons before creating a new one. |
| 3 | Fix `resolveConfig()` throw → envelope | high | 20 min | 3 call sites in `index.js`. Wrap in try/catch → invalidInputError. |
| 4 | Apply observer safety rules in `manifest-to-observations.mjs:48-52` | high | 30 min | Reject phone-as-name / email-as-name / Unicode-masked at transformer; fall through to null, surface in skipped.ndjson. Cuts 5,199 junk names. |
| 5 | Update CLAUDE.md top section (routes, tables, test count) | critical | 20 min | 3-line fix covering lines 9-13, 15, 21, 31. |
| 6 | Add README index entries for docs 12 + 13 | high | 5 min | One-line each. |
| 7 | Add audit-field for "stale" to `03-current-state.md` or split into `03-pre-v0.md` + `03-current-v0.md` | high | 45 min | Either rewrite in place or bifurcate. |
| 8 | Add smoke tests for `manifest-to-observations.mjs` + `generate-merges.mjs` | critical | 2 hr | Golden-fixture approach; 5 fixture manifest rows → assert observation shape. Would have caught #1 and #4. |
| 9 | File the 6 invisible debt items into memory or a TODO doc | medium | 30 min | Unicode-masked, sender_name fallback, CI/monitoring, observability, workaround, dup-detection. |
| 10 | Update handoff §3.3 with post-Stage-5 DB counts | medium | 10 min | One-line fix with current numbers. |

Items 1+2+8 together cost roughly half a day and fix the critical data-quality findings. Items 3+4 harden the ingest path against the exact bug class that produced 5,199 bad names.

---

## Biggest invisible risk

**The v2/v3 manifest divergence, compounded by the placeholder `relationship_to_me` string.**

Concretely: a founder opening the UI (once built) and fetching any of the 6,807 bulk persons will see a `relationship_to_me` reading *"Appears in 2 threads across 3 channels. Pending enrichment."* This sentence is grammatically a real description. In 80% of UI contexts it will render like a one-sentence summary, indistinguishable at a glance from an enriched one. A harried user scrolling cards won't realize they're looking at structural placeholders — they'll read them as context and trust them accordingly. Worse, because the DB was loaded from v2, the founder's mental model (trained on the viz) won't match the cards they see.

This is the compounding failure: **the system looks populated, but the population is fictive enrichment layered on the wrong manifest version.** The two defenses are (a) renaming the placeholder to something visibly non-prose ("PLACEHOLDER · 2 threads · 3 channels · awaiting enrichment"), and (b) never showing a bulk-placeholder card in the UI until Layer-2 enrichment has actually run. Neither defense is in the code today, and neither debt is tracked in memory.

The v2/v3 reingest is the narrow fix. The placeholder-honesty is the broader fix. Until both land, every hour the UI work moves forward is an hour spent building on sand.

---

## Coda

The session produced strong plumbing code, decent design docs, and a data load that isn't yet honest enough to build on. If I had to state the guiding discipline in one line: **the plumbing passes its own discipline audit; the data does not pass the plumbing's own rules.** The observer SKILL's safety rules, if applied retroactively to the 6,807 bulk rows, would reject 5,199 of them. That's the most concrete measure of the gap between what you've designed and what you've shipped to the DB.

Close that gap before UI.
