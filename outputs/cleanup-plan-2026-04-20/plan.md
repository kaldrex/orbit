# Orbit data-quality cleanup — execution plan (2026-04-20)

**Author:** Claude Opus 4.7 (plan mode, read-only)
**Source inputs:** `/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/outputs/audit-2026-04-20/report.md`
**Scope branch:** `worktree-autonomous-2026-04-19` @ `a351f69`
**Target DB:** Supabase project `xrfcmjllsotkwxxkfamb`, user_id `dbb398c2-1eff-4eee-ae10-bad13be5fda7` (Sanchay)
**Reviewer action:** read, mark any decision points (§5), then approve to execute.

---

## 1. Executive summary

- **What gets fixed.** (a) Safety rules move from markdown prose to `orbit-rules-plugin/lib/safety.mjs` with 15+ tests, enforced at observer emission and bulk transform alike. (b) The 5,199 phone/email/Unicode-masked-phone/quoted-literal/test-leak names in `observations.payload.name` get purged via a full re-ingest from v3 (recommended — see §5, decision D1). (c) Umayr and Ramon duplicate `person_id`s collapse to their April 19 originals, preserving enriched category + `relationship_to_me`. (d) `resolveConfig()` stops throwing and returns the `{error:{code:"INVALID_INPUT"}}` envelope. (e) `sanchaythalnerkar@gmail.com` hardcode falls out for `ORBIT_SELF_EMAIL` / `ORBIT_SELF_PHONE`. (f) Placeholder `"Appears in N threads…"` prose is migrated to structured nulls so a UI can render "awaiting enrichment" honestly. (g) Manifest-gen learns to read enriched persons back from the API so the viz and DB converge. (h) Docs (`CLAUDE.md`, `03-current-state.md`, `11-v0-pipeline-handoff-…`, `agent-docs/README.md`, docs 12 + 13 status headers) are re-aligned to reality; six invisible-debt items get memory entries.
- **Total effort: ~18.5 focused hours** (Phase A 4 h · Phase B 5 h · Phase C 3.5 h · Phase D 2 h · buffer / test stabilization / re-ingest wait 4 h). Wall-clock 2 working days with review gates.
- **Biggest risk:** Phase B Step 2 (re-ingest from v3). Any deletion of `observations` rows violates append-only; we avoid `DELETE` by using the `user_id`-scoped wipe gated behind Supabase RLS on a test project, but the recommended path (D1 = full re-ingest) requires truncating the 6,807 bulk rows + their links. Rollback is a full re-run from the new v3 NDJSON plus merge generation; re-run cost is ~30 min wall, ~$0. Data is not lost — `raw_events` (33,105 rows) is the reproducible source, and v3 is regenerable from claw any time.
- **Biggest invisible risk if plan is rejected:** every additional day of UI work after 2026-04-20 builds on placeholder enrichment from a stale manifest. A founder reviewing a card today cannot visually distinguish "we know nothing about this person" from "we know a little." One merged PR of UI-over-placeholder concretizes that drift.
- **What this plan does NOT attempt:** no Layer 2 (blocklist table) or Layer 3 (self-writing heuristics) implementation — doc 12 §Layer-2/3 is still design-only and not in this plan's scope. No multi-founder sign-up UI (doc 13 §"API key issuance UI"). No Stage 6 LLM enrichment itself — only the plumbing that lets it happen cleanly.

---

## 2. Per-phase plan

### Phase A — WhatsApp depth fixes

**Objective.** Move every "discussed but not coded" WhatsApp data-quality rule into `orbit-rules-plugin/lib/` as pure functions with real-failure-data test fixtures, so Phase B's re-ingest benefits from them.

**Ordered steps.**

#### A1. Add `safety.mjs` (load-bearing for Phase B) — **30 min**

- **File:** create `/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/orbit-rules-plugin/lib/safety.mjs`.
- **Change nature.** Port the four safety-drop rules from `orbit-claw-skills/orbit-observer/SKILL.md:142-146` into code. Exports:
  - `isPhoneAsName(name: string): boolean` — matches `/^\+?\d{6,}$/u`. ~3 LOC.
  - `isUnicodeMaskedPhone(name: string): boolean` — matches `/^\+?[\d\s.\-∙•·・]{6,}$/u` (explicit class covering U+2219 "bullet operator" ∙, U+2022 "bullet" •, U+00B7 "middle dot" ·, U+30FB "katakana middle dot" ・, plus ASCII space/dot/hyphen). ~6 LOC.
  - `isEmailAsName(name: string): boolean` — matches `/.+@.+/u`. ~2 LOC.
  - `isQuotedLiteralName(name: string): boolean` — matches `/^['"‘’“”`]{1}.+['"‘’“”`]{1}$/u`. ~3 LOC. Covers the 5 `'Sarmista'`-class DB rows.
  - `isEmptyOrWhitespace(name: string): boolean` — `name.trim() === ""`. ~2 LOC.
  - `isKnownBotName(name: string): boolean` — blocklist set `["wazowski","chad","axe","kite","slackbot","github-actions"]` with case-insensitive compare. ~4 LOC.
  - `isTestDataLeak(name: string, emails: string[], phones: string[]): boolean` — matches `example.com`, `example.org`, `test.com`, `apitest.*@` against any of the three strings. ~8 LOC. Kills the `apitest.lead@example.com` class.
  - `safetyDropReason(candidate: {name, emails[], phones[]}): string | null` — single orchestrator that runs all six checks and returns the first matching reason code (`"phone_as_name"`, `"unicode_masked_phone"`, `"email_as_name"`, `"quoted_literal"`, `"empty_name"`, `"bot_name"`, `"test_data_leak"`) or `null` to pass. ~15 LOC.
- **Tests to add.** New file `tests/unit/orbit-rules-plugin-safety.test.mjs`:
  1. phone-as-name positives: `"+971586783040"`, `"971586783040"`, `"+917208148746"`, `"+1 202 555 0199"` (with spaces). Negatives: `"Umayr Sheik"`, `"1-800 flowers"` (ambiguous — document the negative).
  2. Unicode-masked positives pulled from real DB violations: `"+91∙∙∙∙∙∙∙∙46"`, `"+91•••••••••46"`, `"+91·········46"`. Plus 2 hand-built edge cases from the middle-dot variant set.
  3. email-as-name positives: `"usheik@sinxsolutions.ai"`, `"apitest.lead@example.com"`. Negative: `"Hari @ Skydo"` (contains @ — document that we currently accept this as junk and may later refine via `@ vs email-shape`).
  4. quoted-literal positives: `"'Sarmista'"`, `"\"Amit\""`, `"‘Tamas’"`.
  5. empty / whitespace: `""`, `"   "`, `"\t\n"`.
  6. bot-name positives + case: `"wazowski"`, `"Wazowski"`, `"slackbot"`.
  7. test-data-leak: any of the three fields matches `apitest.lead@example.com`, `john@test.com`, `+15555555555` (no phone pattern — document that phone-test markers are NOT in this rule; we rely on the domain check alone).
  8. `safetyDropReason` orchestrator: precedence test — if input has both `@` in name AND phone-as-name, returns the first match. Order: phone > unicode > email > quoted > empty > bot > test-leak.
- **Time estimate.** 30 min (code + tests).
- **Risk.** Low. Pure functions, no I/O. Over-strict unicode regex could false-positive on "+971 58 678 3040" if we forget to include ASCII space — mitigated by test case 1.b.
- **Rollback.** `git revert` the single commit; no data side-effects.

#### A2. Add `name.mjs` with `pickBestName()` + `messages.sender_name` fallback — **45 min**

- **File:** create `/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/orbit-rules-plugin/lib/name.mjs`.
- **Change nature.** Extracts the `pickName()` logic currently inline at `outputs/manifest-hypothesis-2026-04-19/manifest-gen.mjs:890-920` into a reusable module. Adds a new lower-priority source `wa_message_sender`:
  - Export `pickBestName(cands: Array<{source, name}>): string | null`. Priority order: `wa_contact` > `google_contact` > `gmail_from` > `gmail_to_cc` > `wa_group_sender` > `wa_message_sender` > `unknown`. Each candidate filtered via `safety.safetyDropReason()` from A1 before sort. ~40 LOC.
  - Export `collectMessageSenderNames(db, jid): Array<{name, count, ts_max}>` — reads `SELECT sender_name, COUNT(*) AS count, MAX(ts) AS ts_max FROM messages WHERE sender_jid = ? AND sender_name IS NOT NULL AND sender_name != '' GROUP BY sender_name ORDER BY count DESC LIMIT 3`. Returns candidates from WhatsApp message push_name fields. This is the source that would name 500-800 humans currently null. ~20 LOC.
- **Tests to add.** New file `tests/unit/orbit-rules-plugin-name.test.mjs`:
  1. Priority ordering: given `[{source:"wa_group_sender", name:"U"}, {source:"wa_contact", name:"Umayr Sheik"}]`, returns `"Umayr Sheik"`.
  2. Safety filtering: given `[{source:"wa_contact", name:"+971586783040"}]` returns `null`, NOT the phone.
  3. Tie on priority → longer string wins: `[{source:"wa_contact", name:"Umayr"}, {source:"wa_contact", name:"Umayr Sheik"}]` returns `"Umayr Sheik"`.
  4. All candidates rejected by safety → returns `null` (this is the "surface as null, let downstream handle" contract).
  5. `wa_message_sender` sits between `wa_group_sender` and `unknown` — test explicit precedence.
  6. `collectMessageSenderNames` with a mock sqlite db (use `tests/fixtures/wacli-minimal.db` + a new fixture row if needed) returns ordered `[{name, count, ts_max}]`.
- **Time estimate.** 45 min (code + sqlite fixture + tests).
- **Risk.** Medium-low. Sqlite fixture may need regeneration via `tests/fixtures/build-wacli-minimal.mjs` if `sender_name` column isn't populated.
- **Rollback.** `git revert`; remove the module import. `manifest-gen.mjs` still ships its own inline `pickName`, so nothing is lost if we revert.

#### A3. Add `bareLid()` helper + apply consistently — **30 min**

- **Files touched (read):** `orbit-rules-plugin/lib/lid.mjs:55,98,139`, `outputs/manifest-hypothesis-2026-04-19/manifest-gen.mjs` (scan for `@lid` string ops).
- **File created:** append to `orbit-rules-plugin/lib/lid.mjs` (top-level export, same file so consumers have one import).
- **Change nature.** Export `bareLid(jid: string): string | null` that strips trailing `@lid` AND any `:<device>` suffix (`10307938324603:28` → `10307938324603`). Today, `lid.mjs:55` strips only the `@lid`; the Hardeep LID `10307938324603:28` vs `10307938324603:30` skip documented in audit §1 (`stage-5-bulk-ingest-2026-04-19/skipped.ndjson`) is the exact failure mode. ~8 LOC.
- **Call sites to refactor.**
  - `orbit-rules-plugin/lib/lid.mjs:55` — replace inline `replace(/@lid$/i, "").trim()` with `bareLid(rawLid)`.
  - `orbit-rules-plugin/lib/lid.mjs:98` — inside `phoneForContact`, use `bareLid(jid)` instead of `jid.slice(0, -4).trim()`.
  - `orbit-rules-plugin/lib/lid.mjs:139` — inside `isResolvableLidContact`, same replacement.
- **Tests to add.** Append cases to existing `tests/unit/orbit-rules-plugin.test.mjs` `describe('lid')` block:
  1. `bareLid("10307938324603:28@lid")` → `"10307938324603"`.
  2. `bareLid("10307938324603:30")` → `"10307938324603"`.
  3. `bareLid("10307938324603")` → `"10307938324603"`.
  4. `bareLid("10307938324603@lid")` → `"10307938324603"`.
  5. `bareLid("")` → `null`.
  6. `bareLid(null)` → `null`.
  7. Integration: two fixture rows `{jid: "10307938324603:28@lid"}` and `{jid: "10307938324603:30@lid"}` both resolve to the same bare LID; downstream `lidToPhone` hit is a single row.
- **Time estimate.** 30 min.
- **Risk.** Low. If the whatsmeow map uses keys with the device suffix included somewhere, tests would catch — mitigated by the fixture-level integration test (#7). Spot-check on claw via read-only `sqlite3 ~/.wacli/session.db "SELECT lid FROM whatsmeow_lid_map WHERE lid LIKE '%:%' LIMIT 5"` before merging. **This is a read, permitted under guardrails.**
- **Rollback.** `git revert`; no data side-effects.

#### A4. Add `group-junk.mjs` — mega-lurker + broadcast-ratio + commercial-keyword — **1 h 15 min**

- **File:** create `/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/orbit-rules-plugin/lib/group-junk.mjs`.
- **Change nature.** Three pure-ish functions + one aggregator. Per `agent-docs/12-junk-filtering-system.md:82-84`:
  - `isMegaLurkerGroup({member_count, self_outbound_count}): {junk, reason, confidence}` — returns `{junk:true, reason:"mega_lurker", confidence:0.85}` iff `member_count > 200 && self_outbound_count === 0`. ~10 LOC.
  - `isBroadcastRatioGroup({sender_counts}): {junk, reason, confidence}` — given a `Record<senderJid, count>`, returns junk when top sender > 80% of total messages AND total > 10 (avoid false positives on tiny groups). ~15 LOC.
  - `isCommercialKeywordGroup({group_name}): {junk, reason, confidence}` — regex `/\b(sale|deal|offer|crypto|giveaway|coupon|promo|discount|airdrop|signup bonus|referral)\b/i` against the group name. ~8 LOC.
  - `classifyGroup(ctx): {junk, reasons[], max_confidence}` — runs all three, aggregates. ~15 LOC.
- **Tests to add.** New file `tests/unit/orbit-rules-plugin-group-junk.test.mjs`:
  1. Mega-lurker positive: `{member_count: 247, self_outbound_count: 0}` → junk.
  2. Mega-lurker negative (small group with 0 outbound is NOT junk): `{member_count: 5, self_outbound_count: 0}` → not junk.
  3. Mega-lurker negative (Sanchay participates): `{member_count: 500, self_outbound_count: 3}` → not junk.
  4. Broadcast-ratio positive: `{sender_counts: {"A":85,"B":10,"C":5}}` (total 100, A=85%) → junk with reason.
  5. Broadcast-ratio negative (below threshold): `{sender_counts: {"A":50,"B":30,"C":20}}` → not junk.
  6. Broadcast-ratio negative (total too small): `{sender_counts: {"A":8,"B":1,"C":1}}` → not junk (size gate).
  7. Commercial positives: `"BTC Giveaway"`, `"Forsage Deals"`, `"Mega Sale Alerts"`, `"Crypto Signup Bonus"`.
  8. Commercial negatives: `"Deal Team — Acme Co"`, `"Crypto Thesis Book Club"` (false-positive audit; flag as documented current behavior — noted in §5 D4 for reviewer).
  9. `classifyGroup` aggregation: a group matching mega-lurker + commercial returns both reasons, `max_confidence = 0.85`.
- **Time estimate.** 1 h 15 min (regex tuning on commercial keywords alone is 20 min).
- **Risk.** Medium. Commercial-keyword regex will over-match on legitimate business groups (cf. audit §2 "Top 20 group names all look clean" — don't break that). Mitigation: `classifyGroup` is advisory in this phase — nothing auto-writes blocklist; Layer 2/3 is out of scope. Results are **only used to annotate manifest-gen output for Sanchay review**, not to auto-exclude.
- **Rollback.** Revert commit; nothing consumes these functions at Phase A exit (they're plumbed into manifest-gen in Phase C).

#### A5. Plug A1–A4 back into `manifest-gen.mjs` — **30 min**

- **Files touched.** Two copies to keep in sync (audit confirms both exist):
  - `/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/outputs/manifest-hypothesis-2026-04-19/manifest-gen.mjs` (Mac worktree copy — the one that was last run).
  - Deploy target on claw: `~/.openclaw/plugins/orbit-rules/manifest-gen.mjs` (via `scp`, after review — NOT in this plan phase).
- **Change nature (Mac copy only — claw deploy is a human-approved step at Phase B2).**
  - Replace inline `pickName` at line 890-920 with `import { pickBestName, collectMessageSenderNames } from "../../orbit-rules-plugin/lib/name.mjs"` (or, since manifest-gen is designed to be self-contained on claw, duplicate via a small codegen — see §5 D2 for reviewer to resolve).
  - Replace inline phone-as-name / email-as-name filters at `manifest-gen.mjs:905-906` with `safetyDropReason()` from `safety.mjs`.
  - Inside the wa-messages scan block (around line 548-595), after the existing group-participant loop, add a per-chat-jid call to `collectMessageSenderNames` for each `@s.whatsapp.net` DM peer that has no name from contacts. Append candidates to the name-candidate bucket with source `wa_message_sender`.
  - Call `classifyGroup()` per group after the group scan (around line 595); attach `junk_signals: [...]` to each group object. **Does not exclude** — Phase A only annotates; Phase B's re-ingest decision (§5 D4) decides whether to exclude.
- **Tests to add.** Integration test `tests/integration/manifest-gen-safety.test.mjs` — mocks a 3-line wacli.db (one contact with a real name, one with a LID-only ghost, one whose only name source is a `messages.sender_name`) + checks the emitted NDJSON has 2 rows (ghost dropped, message-sender-named row kept with correct name).
- **Time estimate.** 30 min.
- **Risk.** Medium. The import-vs-duplicate decision is load-bearing (manifest-gen runs on claw standalone, `../../orbit-rules-plugin/lib/…` won't resolve under `~/.openclaw/plugins/`). Decision point D2.
- **Rollback.** Revert commit; manifest-gen reverts to v3-era behavior; Phase B halts.

**Phase A acceptance.**
- `npm test` passes with ≥ 30 new tests added (196 → ~226).
- `git diff orbit-rules-plugin/lib/` shows 4 new `.mjs` files (`safety`, `name`, `group-junk`) and 1 edit (`lid.mjs`).
- No DB writes yet. No SCP to claw yet.

---

### Phase B — Audit critical cleanup

**Objective.** Clean the DB: fix the `resolveConfig` bug, wipe the placeholder + junk-name population, re-seed from v3 with safety rules enforced, and collapse the Umayr/Ramon duplicates — in that order.

**Ordered steps.**

#### B1. Fix `resolveConfig()` error envelope — **20 min**

- **File:** `/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/orbit-cli-plugin/lib/env.mjs` + `/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/orbit-cli-plugin/index.js`.
- **Change nature.**
  - `env.mjs:11-19`: change `resolveConfig` to return `{ok:true, config:{url,key}}` on success or `{ok:false, error:{code:"INVALID_INPUT", message, suggestion}}` on missing env. Use `invalidInputError()` from `errors.mjs:162`. ~12 LOC change, same file.
  - `index.js:70-71, 99-100, 118-119`: wrap each `execute` arrow. Today: `envelope(await orbitObservationEmit(params ?? {}, {config: resolveConfig()}))`. New: call `resolveConfig()` first, if `!ok` return `envelope(err)` immediately; otherwise call the client. ~3×4 = 12 LOC.
- **Tests to add.** New describe block in `tests/unit/orbit-cli-plugin.test.mjs`:
  1. `GIVEN ORBIT_API_URL is unset, WHEN orbit_observation_emit is invoked, THEN return envelope with parsed error.code === "INVALID_INPUT"`.
  2. `GIVEN ORBIT_API_KEY is unset, SAME contract`.
  3. `GIVEN both set, WHEN invoked, THEN no INVALID_INPUT error` (happy path regression).
  4. Same three for `orbit_observation_bulk` and `orbit_person_get`.
  5. Assert `fetch` is NOT called when env is missing (spy on globalThis.fetch; expect 0 calls).
- **Time estimate.** 20 min.
- **Risk.** Very low. `env.mjs` is 19 LOC total; it changes shape but no external consumer reads `resolveConfig()` for the old throw-contract (verified via grep).
- **Rollback.** Revert commit. Agent regresses to throwing on missing env.

#### B2. Safety-first re-transform to v3 NDJSON — **1 h**

- **File:** `/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/scripts/manifest-to-observations.mjs`.
- **Change nature.**
  - Line 25-28: change INPUT from `outputs/fixes-applied-2026-04-19/orbit-manifest-v2.ndjson` to `outputs/manifest-hypothesis-2026-04-19/orbit-manifest-v3.ndjson`. ~1 LOC.
  - Line 29-31: change OUT_DIR to `outputs/stage-5c-reingest-2026-04-20` (new dir) so we don't overwrite evidence. ~2 LOC.
  - Line 48-52 (the lethal fallback): replace entire name picker with `safetyDropReason({name: m.name, emails: m.emails, phones: m.phones})`. If reason returned, skip the manifest line — write to `skipped.ndjson` with `reason`. If null, use `m.name` directly. Absolutely no fallback to phone/email. ~18 LOC.
  - Lines 67-68 (the placeholder `relationship_to_me`): decide per §5 D3. Recommended default: set `relationship_to_me: ""` (empty string — the zod schema default is `""`). NO structural prose. `payload.category` stays `"other"`.
  - Add comment block at top: "Safety rules enforced via `orbit-rules-plugin/lib/safety.mjs`. Rows that trip the filter land in skipped.ndjson — NOT in observations.ndjson, regardless of other fields present."
- **Tests to add.** New file `tests/unit/manifest-to-observations.test.mjs` (this was explicitly called out as missing in audit §3):
  1. Given a manifest line with `name: "+971586783040"` (phone-as-name), assert output is a SKIPPED row with reason `"phone_as_name"`, NOT an observation.
  2. Given `name: "Umayr Sheik"`, assert observation emitted with `payload.name === "Umayr Sheik"`.
  3. Given `name: null, phones: ["+971..."]`, assert observation emitted with `payload.name === null` (schema permits after §5 D3; if D3 resolves to "keep non-null", assert SKIPPED with reason `"no_safe_name"`).
  4. Given `name: "+91∙∙∙∙∙∙∙∙46"`, assert SKIPPED with `"unicode_masked_phone"`.
  5. Given `name: "apitest.lead@example.com"`, assert SKIPPED with `"email_as_name"` OR `"test_data_leak"` (either is fine — test asserts "not emitted").
  6. Given input manifest with 100 mixed lines, assert output count + skipped count sums to 100 exactly.
  7. Regression: `observed_at` with trailing `Z` still gets converted to `+00:00`.
  8. Regression: `relationship_to_me` is `""`, NOT the placeholder prose (per §5 D3).
- **Run (manual step, post-test-green).** `node scripts/manifest-to-observations.mjs` → produces `outputs/stage-5c-reingest-2026-04-20/observations.ndjson` + `skipped.ndjson`. Count check: expect `observations.ndjson` lines ≈ 1,600-2,000 (those with safe names), `skipped.ndjson` ≈ 4,800-5,200 (all the `_as_name` kinds).
- **Time estimate.** 1 h (30 min code, 30 min tests including manifest fixture).
- **Risk.** Medium. If §5 D3 resolves toward "keep placeholder prose," the test and the code need rewiring. **Blocker for B3 and B4.**
- **Rollback.** Revert commit. The new `outputs/stage-5c-reingest-2026-04-20/` dir is not yet consumed.

#### B3. DB cleanup — wipe + re-ingest (recommended path D1-A) — **1 h 15 min**

> **Decision point D1:** §5 offers three options. This plan's default is **D1-A (truncate bulk observations + re-ingest)**. If reviewer prefers D1-B (emit correction observations per-row) or D1-C (schema/view layer for null names), swap this step for the alternate. D1-A is the cleanest and least drift-prone given the log-first-retry-never discipline.

- **Files touched.**
  - New script `/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/scripts/migrations/002-wipe-stage5-bulk.sql`. Deletes rows scoped by `user_id = 'dbb398c2-…' AND evidence_pointer LIKE 'manifest://%'` from `observations`, and cascades via FK to `person_observation_links` + orphans in `persons`. ~25 LOC of SQL.
  - New script `/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/scripts/reingest-stage5c.mjs` — a thin wrapper that calls the CLI plugin's `orbit_observation_bulk({file_path:…observations.ndjson})` via local `import` (bypasses OpenClaw runtime — uses `orbit-cli-plugin/lib/client.mjs:orbitObservationBulk` directly). ~40 LOC.
- **Change nature (SQL migration).**
  ```sql
  -- Stage 5 bulk wipe: remove ONLY manifest-sourced rows. Never touches the
  -- April 19 fixture rows (which have evidence_pointer = 'wacli://...' or
  -- 'gmail://...'). Scoped by user_id so even if RLS is bypassed we don't
  -- reach another tenant.
  BEGIN;
  DELETE FROM person_observation_links
    WHERE observation_id IN (
      SELECT id FROM observations
      WHERE user_id = 'dbb398c2-1eff-4eee-ae10-bad13be5fda7'
        AND (evidence_pointer LIKE 'manifest://%'
             OR evidence_pointer LIKE 'merge://%')
    );
  DELETE FROM persons
    WHERE user_id = 'dbb398c2-1eff-4eee-ae10-bad13be5fda7'
      AND id NOT IN (SELECT DISTINCT person_id FROM person_observation_links
                     WHERE user_id = 'dbb398c2-1eff-4eee-ae10-bad13be5fda7');
  DELETE FROM observations
    WHERE user_id = 'dbb398c2-1eff-4eee-ae10-bad13be5fda7'
      AND (evidence_pointer LIKE 'manifest://%'
           OR evidence_pointer LIKE 'merge://%');
  -- sanity: remaining observation count should be Umayr's 6 + Ramon's 6 = 12.
  SELECT COUNT(*) AS remaining_observations FROM observations
    WHERE user_id = 'dbb398c2-1eff-4eee-ae10-bad13be5fda7';
  -- Expected: 12
  COMMIT;
  ```
- **Run order (manual, reviewer-approved).**
  1. Pre-flight SELECT counts: `SELECT COUNT(*) FROM observations WHERE evidence_pointer LIKE 'manifest://%'` → expect 6,807. `SELECT COUNT(*) FROM observations WHERE evidence_pointer LIKE 'merge://%'` → expect 6,807.
  2. Pre-flight dump: `outputs/stage-5c-reingest-2026-04-20/pre-wipe-dump.ndjson` — `pg_dump` filtered to the scoped rows, as evidence before destructive op. Size ~ 20 MB.
  3. Run migration 002 in a Supabase SQL transaction.
  4. Verify post-delete: `SELECT COUNT(*) FROM observations WHERE user_id = 'dbb398c2-…'` → expect 12 (pre-Stage-5 fixtures only: 4+1 Umayr + 3+1 Ramon + 2 merge + 1 correction = 12).
  5. Re-ingest: `node scripts/reingest-stage5c.mjs` → writes new `observations.ndjson` from B2 to `/api/v1/observations` via the CLI client. Expect `total_inserted ≈ 1,800`, `total_deduped` = 0 (fresh DB).
  6. Post-ingest verify: `SELECT COUNT(*) FROM persons` → expect ~1,800 (matches the non-skipped manifest lines).
- **Tests to add.** None for the SQL itself (it's a one-shot migration and should not re-run). Tests for `reingest-stage5c.mjs` are subsumed by B2's tests for the transformer.
- **Time estimate.** 1 h 15 min (30 min SQL + dump + review, 15 min re-ingest run, 30 min post-verification).
- **Risk.** HIGH (destructive). Mitigations:
  - Pre-wipe `pg_dump` to an NDJSON file stored under `outputs/stage-5c-reingest-2026-04-20/pre-wipe-dump.ndjson` — full row backup.
  - Both the migration and the re-ingest are reviewer-approved step-by-step. Reviewer eyes the pre-flight counts, approves the BEGIN, the DELETEs, the COMMIT separately.
  - `user_id` scoping is belt-and-suspenders even though Supabase RLS already scopes.
- **Rollback.** Restore from `pre-wipe-dump.ndjson` via a dedicated `restore.mjs` script that re-posts through the API. 30 min. No data loss.

#### B4. Merge-generation against existing persons (Umayr + Ramon duplicate fix) — **1 h 45 min**

- **Files touched.**
  - `/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/outputs/stage-5b-merges-2026-04-19/generate-merges.mjs` — extend OR create a sibling `scripts/generate-merges-v2.mjs`. **Prefer the sibling** (keep `generate-merges.mjs` as audit artifact, new script lives under `scripts/` per audit §4 "moved to scripts").
  - New `/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/scripts/generate-merges-v2.mjs`.
- **Change nature.**
  - Before emitting a new `person_id`, query existing persons by deterministic bridge. For each manifest person-obs:
    1. Build `bridges = [...phones.map(p=>`phone:${p}`), ...emails.map(e=>`email:${e}`)]`.
    2. Query `SELECT id FROM persons WHERE user_id = $1 AND (phones && $2 OR emails && $3) LIMIT 1` — using Postgres array-overlap `&&` against the phone & email arrays.
    3. If a pre-existing person matches, emit `kind:"merge"` with `payload.person_id = <existing_id>` (NOT a new UUID). This bridges the new observation into Umayr's existing `67050b91-…` and Ramon's `9e7c0448-…`.
    4. Else emit with a fresh UUID.
  - `merged_observation_ids: [row.id, row.id]` workaround is still needed (schema `.min(2)`). Add an inline TODO tag: `// TODO(schema-min2): see outputs/cleanup-plan-2026-04-20/plan.md §5 D5`.
  - Preserve Umayr + Ramon enriched fields: the merge observation DOES NOT carry `payload.category` or `payload.relationship_to_me`. Those are only on `kind:"person"` observations. By leaving the April 19 fixture person observations alone, and linking the new manifest-person observation as a second `person_observation_link`, the materialized `persons` row keeps the latest-by-timestamp winning field. **Verify** in Phase B acceptance that `Umayr's relationship_to_me` remains `"Close friend and tech peer based in Dubai…"` (see audit §4.1).
- **Tests to add.** New file `tests/unit/generate-merges-v2.test.mjs`:
  1. Given an existing person with phone `+971586783040` in DB AND a fresh manifest-person with the same phone, assert emitted merge has `payload.person_id === <existing_id>`.
  2. Given NO existing person match, assert fresh UUID is generated.
  3. Given manifest-person with 2 phones, only one of which matches existing, assert existing wins (don't fork).
  4. Given manifest-person whose phones overlap with TWO existing persons (pathological — should not happen post-safety but must not crash), assert the script emits to a `conflicts.ndjson` file for manual review + skips the merge.
  5. The Umayr-specific regression: stub the query to return Umayr's id; assert merge binds.
- **Integration test — live DB spot-check (no mutations).** Before running the script for real, run it with `--dry-run` flag; expect:
  - `would_bind_to_existing_person: 2` (one each for Umayr, Ramon).
  - `would_create_new_person: ~1,800`.
- **Run (manual, reviewer-approved).**
  1. `node scripts/generate-merges-v2.mjs --dry-run` → outputs a summary without calling `/api/v1/observations`.
  2. Review the 2 "would bind" rows against Umayr/Ramon known UUIDs.
  3. `node scripts/generate-merges-v2.mjs` (no dry-run) → full merge-emission.
  4. `GET /api/v1/person/67050b91-5011-4ba6-b230-9a387879717a/card` → expect unchanged `relationship_to_me` and `category`, but `observations.total` increases from 6 → 7.
  5. `SELECT COUNT(*) FROM persons WHERE user_id = '...'` → expect ~1,800 (NOT 1,802 — Umayr + Ramon collapsed).
  6. Confirm no Umayr/Ramon duplicates: `SELECT name, COUNT(*) FROM persons WHERE user_id = '...' GROUP BY name HAVING COUNT(*) > 1` — expect 0 rows for `Umayr*` and `Ramon*`.
- **Time estimate.** 1 h 45 min.
- **Risk.** Medium. The array-overlap `&&` query requires a GIN index on `persons.phones` + `persons.emails` to stay fast. Without it, 1,800 serial queries take ~10 min instead of <30 s. Pre-flight check: `SELECT indexname FROM pg_indexes WHERE tablename = 'persons'`. If missing, add `CREATE INDEX CONCURRENTLY` migration 003 (adds 5 min to the plan).
- **Rollback.** Same as B3: restore from `pre-wipe-dump.ndjson` + regenerate Phase B3 observations.

#### B5. `ORBIT_SELF_EMAIL` / `ORBIT_SELF_PHONE` env-var refactor — **25 min**

- **Files touched.**
  - `/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/outputs/manifest-hypothesis-2026-04-19/manifest-gen.mjs:31-32`.
  - `~/.openclaw/plugins/orbit-rules/manifest-gen.mjs` on claw (deploy after merge).
  - `/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/.env.local` — add `ORBIT_SELF_EMAIL=sanchaythalnerkar@gmail.com` + `ORBIT_SELF_PHONE=+91<phone>` (reviewer will supply phone).
  - Claw env: `~/.openclaw/.env.ORBIT_SELF_EMAIL` + `~/.openclaw/.env.ORBIT_SELF_PHONE` (new files).
- **Change nature.**
  ```js
  // was: const SELF_EMAILS = new Set(["sanchaythalnerkar@gmail.com"]);
  // now (per agent-docs/13-multi-tenant-onboarding.md:85-89):
  const SELF_EMAILS = new Set(
    (process.env.ORBIT_SELF_EMAIL || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const SELF_PHONES = new Set(
    (process.env.ORBIT_SELF_PHONE || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (SELF_EMAILS.size === 0) {
    console.error("[manifest-gen] refusing to run: ORBIT_SELF_EMAIL is unset — cannot identify owner rows to exclude");
    process.exit(2);
  }
  // SELF_NAME_HINTS stays for now — see §5 D6.
  ```
  Then extend the self-exclusion block near line 885 (`droppedSelf`) to also check `SELF_PHONES`.
- **Tests to add.** Append to `tests/integration/manifest-gen-safety.test.mjs` (from A5):
  1. With env unset, the script fails with exit 2 + the error message (captured via stderr).
  2. With `ORBIT_SELF_EMAIL=a@b.com,c@d.com` and `ORBIT_SELF_PHONE=+1234567`, both owners' rows get dropped.
  3. With only email set, phone-only owner row is NOT dropped (documented).
- **Time estimate.** 25 min.
- **Risk.** Low. Breaking change by design (CLAUDE.md §"hard cutover"). If the env is unset, fail loud.
- **Rollback.** Revert commit; add email back to the hardcoded set.

#### B6. Migrate placeholder prose to null — **20 min**

> **Decision point D3:** §5 offers (a) re-ingest with empty string (default); (b) emit correction observations for every existing bulk row that has the placeholder; (c) leave DB as-is and fix at read time via a view. This plan defaults to (a) — already covered in B2/B3. B6 here handles the residual: **Umayr and Ramon's April 19 observations were NOT bulk, and their enriched `relationship_to_me` IS real prose and must survive.** This step adds a guardrail test so a future bulk regression cannot overwrite them.

- **Files touched.** `/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/tests/integration/person-card-endpoint.test.ts`.
- **Change nature.** Add a regression test that fetches Umayr's card and asserts `relationship_to_me.startsWith("Close friend and tech peer")`, NOT the placeholder string `startsWith("Appears in ")`. One `it(...)` block. ~15 LOC. Guards against any future bulk-transform-without-safety regression.
- **Tests to add.** See above — one test.
- **Time estimate.** 20 min.
- **Risk.** Very low.
- **Rollback.** Revert commit.

**Phase B acceptance.**
- SQL: `SELECT COUNT(*) FROM persons WHERE user_id = '…' AND name ~ '^\+'` returns **0**.
- SQL: `SELECT COUNT(*) FROM persons WHERE user_id = '…' AND name LIKE '%@%'` returns **0**.
- SQL: `SELECT COUNT(*) FROM persons WHERE user_id = '…' AND name ~ '^\+91[∙•·]'` returns **0**.
- SQL: `SELECT COUNT(*) FROM persons WHERE user_id = '…' AND name = 'apitest.lead@example.com'` returns **0**.
- SQL: `SELECT COUNT(*) FROM persons WHERE user_id = '…' AND relationship_to_me LIKE 'Appears in%'` returns **0**.
- SQL: `SELECT name, COUNT(*) FROM persons WHERE user_id = '…' GROUP BY name HAVING COUNT(*) > 1 AND name IN ('Umayr Sheik','Umayr','Ramon Berrios','Ramon B')` returns **0 rows**.
- `GET /api/v1/person/67050b91-…/card` returns Umayr with `category = "team"` and the original `relationship_to_me`.
- `GET /api/v1/person/9e7c0448-…/card` returns Ramon with `category = "founder"`.
- `npm test` — expect ~220 tests, all green.
- `orbit_observation_emit` with ORBIT_API_URL unset returns an error envelope (not a throw).

---

### Phase C — Close the enrichment loop

**Objective.** Teach manifest-gen to read existing enriched persons back from Orbit's API so re-generation preserves — rather than overwrites — LLM-enriched category + relationship_to_me.

**Ordered steps.**

#### C1. Add `/api/v1/persons/enriched` read endpoint — **1 h**

- **Files touched.**
  - New `/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/src/app/api/v1/persons/enriched/route.ts`.
- **Change nature.** Read-only endpoint that returns all enriched persons for the authenticated user. "Enriched" defined as `category != 'other' OR (relationship_to_me IS NOT NULL AND relationship_to_me != '' AND relationship_to_me NOT LIKE 'Appears in%')`. Response shape: `{persons: Array<{id, name, phones[], emails[], category, relationship_to_me, company, title, updated_at}>}`. Pagination via `?cursor=<id>&limit=500`, default limit 500, max 2000. Auth via `getAgentOrSessionAuth` (same pattern as `/api/v1/observations:28`). ~80 LOC. Honors RLS (returns only the user's own rows).
- **Tests to add.** New file `tests/integration/persons-enriched-endpoint.test.ts`:
  1. Unauthenticated → 401.
  2. Authenticated with no enriched persons → `{persons: []}`.
  3. Authenticated with Umayr enriched → returns 1 person with category `team`.
  4. Pagination: seed 5 enriched rows, `?limit=2` → 2 rows + cursor; follow cursor → next 2; then next 1.
  5. RLS: user A cannot see user B's persons (regression test).
- **Time estimate.** 1 h.
- **Risk.** Low.
- **Rollback.** Revert commit; delete route file; no stored migrations.

#### C2. Add `orbit_persons_list_enriched` CLI verb — **45 min**

- **Files touched.** 
  - `/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/orbit-cli-plugin/lib/client.mjs` — append `orbitPersonsListEnriched({cursor, limit}, {config}): Promise<{persons[], next_cursor?} | {error:{…}}>` helper. Follows the same transport pattern as `orbitPersonGet`. ~40 LOC.
  - `/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/orbit-cli-plugin/index.js` — register a fourth tool `orbit_persons_list_enriched`. ~20 LOC.
- **Change nature.** Pure plumbing (zero judgment). Paginates internally on the client side, concatenates pages into a single `{persons}` array, stops at 10 pages as a circuit breaker (log warning, return partial).
- **Tests to add.** Append to `tests/unit/orbit-cli-plugin.test.mjs`:
  1. Happy path: fetch returns `{persons:[…], next_cursor:null}` → client returns the array.
  2. Pagination: first fetch returns `{persons:[…], next_cursor:"abc"}`; second returns `{persons:[…]}` → concat both.
  3. 401 → `{error:{code:"AUTH_FAILED"}}` envelope.
  4. Circuit breaker at 10 pages: fetch mock returns next_cursor forever; client stops, returns partial with a warning flag.
- **Time estimate.** 45 min.
- **Risk.** Low.
- **Rollback.** Revert commit.

#### C3. Wire manifest-gen to merge DB-enriched fields — **1 h**

- **Files touched.** `/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/outputs/manifest-hypothesis-2026-04-19/manifest-gen.mjs`.
- **Change nature.**
  - Before emitting the final NDJSON (near line 880), if `process.env.ORBIT_API_URL` + `ORBIT_API_KEY` are set, call the API's `/api/v1/persons/enriched` endpoint via `fetch` (manifest-gen runs on claw; API reachable over tailnet).
  - Build a lookup keyed by primary phone/email: `enrichedByPhone = Map<phone, {category, relationship_to_me, company, title}>`.
  - During bucket-to-output emission, for each bucket:
    - Compute `enriched = null`; for each phone in `phones`, check `enrichedByPhone.get(phone)`; same for emails. Take first match.
    - If found, **DB wins** on `category`, `relationship_to_me`, `company`, `title`. **Source wins** on `last_touch`, `first_seen`, `thread_count`, `groups[]`, `source_provenance`. Name: DB wins only if DB name length > source name length (preserves renames done in enrichment).
  - If env vars missing, skip the enrichment lookup entirely — manifest-gen still runs, just emits no enriched fields (preserves the standalone-regenerable property).
- **Tests to add.** New integration test `tests/integration/manifest-gen-enrichment-loop.test.ts`:
  1. Seed Supabase test project with Umayr at category=`team`, relationship_to_me=`"Close friend…"`.
  2. Run manifest-gen with `ORBIT_API_URL` pointing at local test server.
  3. Assert emitted Umayr line has `category:"team"` and `relationship_to_me:"Close friend…"`.
  4. Assert `last_touch` reflects the latest message timestamp from fresh source (not whatever was in DB).
  5. Without `ORBIT_API_URL` set, manifest-gen runs cleanly and Umayr's line has no `category`/`relationship_to_me` (unknown-to-manifest).
- **Time estimate.** 1 h.
- **Risk.** Medium. The merge rule "DB wins on category, source wins on last_touch" is load-bearing — if swapped accidentally, enrichment is lost on every regeneration. Mitigation: the integration test above is the diff contract.
- **Rollback.** Revert commit; manifest-gen regenerates without calling the API.

#### C4. Regression test: Umayr re-generation loop — **30 min**

- **Files touched.** Append to `tests/integration/manifest-gen-enrichment-loop.test.ts`.
- **Change nature.** Full round-trip: (1) generate manifest → emit Umayr with enrichment. (2) run `manifest-to-observations` → produces Umayr person observation with `category:"team"`. (3) POST to `/api/v1/observations` → Umayr row still at `category:"team"` (not clobbered to `"other"`). 
- **Tests to add.** Single `it("preserves Umayr's enriched fields across regeneration", ...)`. ~40 LOC.
- **Time estimate.** 30 min.
- **Risk.** Low.
- **Rollback.** Revert commit.

**Phase C acceptance.**
- `GET /api/v1/persons/enriched` returns Umayr + Ramon + 0 others (pre–Stage 6 state).
- `orbit_persons_list_enriched({})` via CLI returns the same two.
- Regenerating the manifest after C3 — Umayr's NDJSON line carries `category:"team"` + original `relationship_to_me`.
- Round-tripping the manifest through transformer → API — Umayr's card reads identical byte-for-byte on non-touch fields.

---

### Phase D — Docs + memory sync

**Objective.** Re-align documentation with reality; surface the six invisible-debt items as memory entries so future sessions can't reintroduce them silently.

**Ordered steps.**

#### D1. Update `CLAUDE.md` top section — **20 min**

- **File:** `/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/CLAUDE.md`.
- **Change nature.** Per audit §5 critical finding:
  - Lines 9-13 "three contracts": update route list to the actual routes: `POST /api/v1/raw_events`, `POST /api/v1/observations`, `GET /api/v1/person/:id/card`, `POST /api/v1/person/:id/correct`, `GET /api/v1/persons/enriched` (post-C1). Remove the `/packet` + `/observation` legacy names.
  - Line 15 "One table (`raw_events`) is source of truth": change to acknowledge `observations` is now the append-only ledger; `raw_events` is parked. Wording: *"Two ledgers: `raw_events` (parked, 33k rows from the 2026-04-17 bootstrap) and `observations` (active, ~1,800 rows post-cleanup). The observer SKILL writes to `observations` via the orbit-cli plugin. `persons` + `person_observation_links` are materialized projections maintained by DB triggers."*
  - Line 21 `npm test` expect count: change `26` → actual post-Phase-B number (likely ~226).
  - Line 31 `26 passing` reference: same fix.
- **Time estimate.** 20 min.
- **Risk.** Low.
- **Rollback.** Revert commit.

#### D2. Rewrite `agent-docs/03-current-state.md` — **45 min**

- **File:** `/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/agent-docs/03-current-state.md`.
- **Change nature.** Full rewrite (audit §5 flags the whole file as pre-observations). Preserve the changelog table at the bottom (append a 2026-04-20 entry). New structure:
  - Backend surface: 5 routes (post-C1).
  - `src/lib/*.ts`: 13 files now (add `observations-schema.ts`, `card-assembler.ts`).
  - Tests: `~226 tests across N files`.
  - Data state table: `observations` count, `persons` count, `person_observation_links` count — updated to post-Phase-B reality.
  - Credentials + env: add `ORBIT_SELF_EMAIL`, `ORBIT_SELF_PHONE`.
  - Preserve section "What's gone (clean-slate prune)" — still accurate, no edits.
- **Time estimate.** 45 min.
- **Risk.** Low.
- **Rollback.** Revert commit.

#### D3. Patch `11-v0-pipeline-handoff-2026-04-19.md` §3.3 — **15 min**

- **File:** `/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/agent-docs/11-v0-pipeline-handoff-2026-04-19.md`.
- **Change nature.** Lines 126-132 — update `observations` count (12 → post-Phase-B actual), `persons` count (2 → ~1,800), `person_observation_links` count. Add a new §3.5 "Post-cleanup 2026-04-20" subheading with a pointer to this plan doc and the verification-log entry.
- **Time estimate.** 15 min.
- **Risk.** Very low.
- **Rollback.** Revert commit.

#### D4. Update `agent-docs/README.md` index — **10 min**

- **File:** `/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/agent-docs/README.md`.
- **Change nature.** Append rows for `12-junk-filtering-system.md` + `13-multi-tenant-onboarding.md` + a future `14-cleanup-2026-04-20.md` (see D5). Update the "start here" bullet to reflect that 11 + 14 are the current session pair. ~10 LOC of markdown table edits.
- **Time estimate.** 10 min.
- **Risk.** Low.
- **Rollback.** Revert commit.

#### D5. Add `agent-docs/14-cleanup-2026-04-20.md` — **20 min**

- **File:** new `/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/agent-docs/14-cleanup-2026-04-20.md`.
- **Change nature.** A narrative summary of what this plan changed once executed. Points at the plan doc, the verification-log entry, the 002 migration. ~60 LOC under 120-line agent-doc invariant.
- **Time estimate.** 20 min (written at end of execution, not before).
- **Risk.** None.
- **Rollback.** Delete file.

#### D6. Stamp status headers on docs 12 + 13 — **10 min**

- **Files:** `agent-docs/12-junk-filtering-system.md:1-3`, `agent-docs/13-multi-tenant-onboarding.md:1-3`.
- **Change nature.** Per audit §5 medium findings — add a status banner:
  ```
  > **Status (as of 2026-04-20):** Layer 1 implemented in `orbit-rules-plugin/lib/{safety,name,group-junk,lid}.mjs` + `manifest-to-observations.mjs`. Layer 2 (blocklist table) and Layer 3 (self-writing heuristics) are design-only — not implemented. Do not rely on this doc as an implemented-system reference.
  ```
  Doc 13 header: *"Status: target design. Code changes (ORBIT_SELF_EMAIL env var) done 2026-04-20. API-key minting UI, signup flow, install-on-new-machine runbook — not yet executed."*
  Also fix `12-junk-filtering-system.md:21` "173 tests green" → current post-Phase-B count.
- **Time estimate.** 10 min.
- **Risk.** Very low.
- **Rollback.** Revert commit.

#### D7. Append Stage 4/5/5b/5c entries to verification-log — **15 min**

- **File:** `/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/outputs/verification-log.md`.
- **Change nature.** Per CLAUDE.md §"No claim without evidence", append:
  - Stage 4 smoke entry — artifact `outputs/stage-4-smoke-2026-04-19/`, commit sha.
  - Stage 5 bulk — artifact path + note "ingested from buggy v2 manifest; superseded by Stage 5c below."
  - Stage 5b merge — path + `[id,id]` workaround caveat.
  - Stage 5c reingest — path `outputs/stage-5c-reingest-2026-04-20/`, commit sha post-Phase-B, method "safety.mjs-gated manifest-to-observations + wipe migration 002".
- **Time estimate.** 15 min.
- **Risk.** None.
- **Rollback.** Revert commit.

#### D8. Memory entries for six invisible-debt items — **30 min**

- **Directory:** `/Users/sanchay/.claude/projects/-Users-sanchay-Documents-projects-personal-orbit/memory/`.
- **Change nature.** Six new files + `MEMORY.md` index append:
  1. `tech_unicode_masked_phone_rule.md` — "Phone-as-name regex must cover U+2219 ∙ / U+2022 • / U+00B7 · / U+30FB ・. See `orbit-rules-plugin/lib/safety.mjs:isUnicodeMaskedPhone`. 109 real DB violations before fix."
  2. `tech_wa_sender_name_fallback.md` — "`messages.sender_name` is a legitimate name source, last-priority. See `orbit-rules-plugin/lib/name.mjs:collectMessageSenderNames`. Names ~500-800 previously-null humans."
  3. `tech_ci_monitoring_gap.md` — "No CI on this repo. No monitoring on `/api/v1/observations` 5xx rate. Pre-v1 debt; `npm test` is the only gate."
  4. `tech_openclaw_agent_observability.md` — "`openclaw agent --verbose --json` is the only structured-log channel for Wazowski runs. Stage 4 found no aggregation layer. Not in doc 11 §7. Gather logs via `ssh claw journalctl -u openclaw-gateway`."
  5. `tech_merge_min2_workaround.md` — "`mergePayloadSchema.merged_observation_ids.min(2)` forces `[id,id]` duplicate workaround in `generate-merges-v2.mjs`. Legitimate-schema change is to `.min(1)` OR to emit a synthetic base-observation twin. See plan §5 D5."
  6. `tech_enriched_person_lookup.md` — "Manifest-gen reads DB-enriched persons via `/api/v1/persons/enriched` or `orbit_persons_list_enriched` CLI verb. DB wins on category + relationship_to_me; source wins on last_touch/thread_count. Loop closes in Phase C."
- Each file ~15 lines. Add matching bullet in `MEMORY.md` index.
- **Time estimate.** 30 min.
- **Risk.** None.
- **Rollback.** Delete files + revert index.

**Phase D acceptance.**
- `rg -n "26 tests|26 passing|173 tests" CLAUDE.md agent-docs/` returns 0 hits (excluding historical changelog).
- `rg -n "Two routes" agent-docs/03-current-state.md` returns 0 hits.
- `agent-docs/README.md` lists docs 11, 12, 13, 14 explicitly.
- `ls /Users/sanchay/.claude/projects/-Users-sanchay-Documents-projects-personal-orbit/memory/` shows 6 new `tech_*.md` files.

---

## 3. Gates between phases

- **Gate A→B.** (i) `npm test` green with ≥ 30 new tests added; (ii) no file under `orbit-rules-plugin/lib/` imports from anything outside the plugin or `node_modules`; (iii) `git diff --stat` on `orbit-rules-plugin/lib/` shows 4 adds + 1 edit only. **If A4's commercial-keyword regex causes any of the audit-§2 "Top 20 clean" groups to be flagged junk, STOP and tune before proceeding.**
- **Gate B2→B3.** (i) Dry-run of the new `manifest-to-observations.mjs` against v3 manifest produces the expected split: ~1,800 observations + ~5,000 skipped. (ii) Reviewer eyes `skipped.ndjson` and confirms 100% of the first 20 skips are genuinely junk (no false-positives on real humans). **Real-human false-positive rate > 1% in the sample → STOP, tune regex, re-run A1/A2 tests.**
- **Gate B3→B4.** (i) `pre-wipe-dump.ndjson` exists and has ~13,614 lines (6,807 obs + 6,807 merges); (ii) post-wipe `SELECT COUNT(*) FROM observations WHERE user_id = '…'` = 12 exactly; (iii) re-ingest reports `total_inserted ≈ 1,800`, `total_deduped = 0`, `failed_batches = []`.
- **Gate B4→C.** (i) Umayr card byte-identical to pre-wipe on enriched fields; (ii) 0 duplicate names in `persons` for the Umayr/Ramon group.
- **Gate C→D.** All Phase C tests green + Umayr regeneration round-trip preserves enrichment.
- **No gate on D.** Doc fixes can ship in parallel with Phase C once C is green.

---

## 4. Execution order + parallelism opportunities

- **Must-be-sequential.**
  - A1 → A2 → A5 (safety blocks name picker; name picker feeds manifest-gen). A3 and A4 are parallel to A2.
  - B1 before B2 (B2's reingest uses the CLI whose env-envelope we just fixed).
  - B2 before B3 (need the new NDJSON file before wiping DB).
  - B3 before B4 (need a clean slate to reason about which rows to bridge).
  - B4 before B6 (Umayr dedup must land before the regression test is meaningful).
  - C1 → C2 → C3 → C4 is strictly sequential.
  - All of B before any of C (C's test seeds the post-cleanup DB).
- **Parallelizable.**
  - A1 (safety.mjs) and A3 (lid.mjs) can be written in parallel. Different files.
  - A4 (group-junk.mjs) is independent of A1/A2/A3.
  - D1–D8 can run largely in parallel at the end. If one person: D7 (verification log) is the only one that **must** wait until after Phase B + C have commits to cite.
  - B5 (`ORBIT_SELF_EMAIL` env var) can run in parallel with B1, B2, B3, B4 because it only touches manifest-gen.mjs and .env.local. Land it early (right after A5) so all subsequent manifest-gen runs pick up the env-var pattern.
  - C1's route + C2's CLI verb can be coded in parallel (contract is fixed by the endpoint shape).
- **Recommended sequence (single operator, ~2 working days).**
  - **Day 1 AM:** A1, A2, A3, A4 (parallel where possible). A5. Run `npm test`. B1, B5.
  - **Day 1 PM:** B2 (code + tests, reviewer approves dry-run output). Pre-wipe `pg_dump`. B3 (wipe + re-ingest, reviewer approves each SQL step).
  - **Day 2 AM:** B4 (merge-generation v2, dry-run, live run). B6 regression test. Confirm Phase B acceptance suite.
  - **Day 2 PM:** C1, C2, C3, C4. D1–D8. Final `npm test` run. Final verification-log append. Commit.

---

## 5. Decision points for human review

| # | Decision | Default | Alternatives | Why it matters |
|---|---|---|---|---|
| **D1** | How to clean the 5,199 junk-name DB rows? | **D1-A: Wipe bulk (`manifest://%`, `merge://%`) observations + re-ingest from v3 with safety rules.** | D1-B: Emit `kind:"correction"` observations for every row (6,807 corrections). D1-C: Schema/view layer marks `persons.name` NULL for any row matching the junk regex at read time; leave DB rows in place. | Affects rollback granularity and whether the observation ledger retains the historical "we once stored a bad name" record. D1-A is cleanest. D1-B preserves forensic history at the cost of doubling ledger volume + making `observations` much noisier. D1-C is a workaround, not a fix. |
| **D2** | Should `manifest-gen.mjs` on claw duplicate the `orbit-rules-plugin/lib/*.mjs` code inline (current pattern) or `require` the plugin? | **Duplicate inline, with a `scripts/sync-manifest-gen.mjs` codegen helper.** | Load the plugin as a node module from claw (`~/.openclaw/plugins/orbit-rules/node_modules/…`). | Phase A5 hinges on this. Inline keeps manifest-gen standalone-regenerable and matches today's pattern at `outputs/manifest-hypothesis-2026-04-19/manifest-gen.mjs:34-103` (all rules are inlined). Require-based would drift easily. |
| **D3** | What goes in `payload.relationship_to_me` for bulk persons post-cleanup? | **Empty string `""` (schema default).** | (a) `null` — requires schema change `z.string()` → `z.string().nullable()`. (b) Keep a structural-but-honestly-flagged string: `"PLACEHOLDER · N threads · M channels · awaiting enrichment"` (audit §"Biggest invisible risk" recommends this). | `""` is the safe path + UI treats as "no data." `null` needs a schema bump. The "PLACEHOLDER ·" variant is the audit's specific advice — Sanchay should weigh UI honesty vs. "looks empty" UX. |
| **D4** | Should the group-junk signals in A4 auto-exclude groups from `manifest-gen` output, or only annotate? | **Annotate only — emit `junk_signals: [...]` in the manifest line. No exclusion.** | Hard exclude: drop groups flagged mega-lurker, broadcast-ratio, commercial-keyword from `groups[]` and from participant counts. | Audit §"Top 20 group names all look clean" warns against over-filter. Annotate keeps us honest; the blocklist table (doc 12 Layer-2) is where exclusion should live once a human has reviewed heuristics. |
| **D5** | Fix the `mergePayloadSchema.merged_observation_ids.min(2)` workaround now or later? | **Later — track as memory entry + inline TODO in B4's script.** | Now: bump schema to `.min(1)` + a DB migration that removes a uniqueness enforcement, ~45 min extra. | Not load-bearing for cleanup; the `[id,id]` workaround is documented and harmless. Deferring keeps the blast radius small. |
| **D6** | Keep `SELF_NAME_HINTS` hardcoded (`["sanchay thalnerkar", "sanchay"]`) in manifest-gen? | **Yes for now — document as known debt.** | Convert to `ORBIT_SELF_NAME_HINTS` env (CSV). | Phonetic/name hints are hard to parameterize (new-tenant "Deep" needs `deep`, `hardeep`, `hardeep gambhir`, `hg`). Defer until multi-tenant demand is real. |
| **D7** | In Phase B2, if the post-cleanup observation count is < 1,500 (too aggressive safety filter), do we unblock and accept a higher floor, or stop and re-tune? | **Stop and re-tune.** 1,500 is the audit's floor for "real people in the founder's network." | Ship at lower count and iterate. | Founder's network is the moat; dropping real people silently is worse than keeping placeholder names. Re-tuning regex is cheap (A1 tests). |
| **D8** | Deploy manifest-gen safety changes to claw during Phase A or only after Phase C green? | **After Phase C green.** | Deploy after Phase A. | Claw's manifest-gen is production for the dogfooded founder. Aligning deploy with the enrichment loop close = one reboot instead of two. |

---

## 6. Acceptance criteria (the "are we done?" checklist)

Each line is a concrete, runnable check. All must pass.

### 6.1. Rules plugin / plumbing
- [ ] `npm test` from repo root returns ≥ 220 tests, 0 failures, 0 skipped, 0 `.todo`.
- [ ] `ls orbit-rules-plugin/lib/` contains `safety.mjs`, `name.mjs`, `group-junk.mjs` (new), plus the existing 7 modules — 10 total.
- [ ] `grep -rn "^\\\\+\\?\\\\d{6,}" orbit-rules-plugin/lib/safety.mjs` finds the phone-as-name regex.
- [ ] `grep -rn "U+2219\|∙\|•\|·" orbit-rules-plugin/lib/safety.mjs` finds the unicode-masked-phone class.
- [ ] `grep -rn "resolveConfig" orbit-cli-plugin/index.js` shows wrapped in try/catch-style envelope returns (no top-level throw).

### 6.2. Database (run read-only SQL as verification)
- [ ] `SELECT COUNT(*) FROM persons WHERE user_id = 'dbb398c2-1eff-4eee-ae10-bad13be5fda7' AND name ~ '^\+'` = **0**.
- [ ] `SELECT COUNT(*) FROM persons WHERE user_id = '…' AND name LIKE '%@%'` = **0**.
- [ ] `SELECT COUNT(*) FROM persons WHERE user_id = '…' AND name ~ '[∙•·]'` = **0**.
- [ ] `SELECT COUNT(*) FROM persons WHERE user_id = '…' AND name = 'apitest.lead@example.com'` = **0**.
- [ ] `SELECT COUNT(*) FROM persons WHERE user_id = '…' AND relationship_to_me LIKE 'Appears in%'` = **0**.
- [ ] `SELECT COUNT(*) FROM persons WHERE user_id = '…'` between **1,400 and 2,000** (post-safety-filter — see D7 floor).
- [ ] `SELECT name, COUNT(*) FROM persons WHERE user_id = '…' AND name IN ('Umayr Sheik','Umayr','Ramon Berrios','Ramon B') GROUP BY name` shows each name exactly once, no duplicates.
- [ ] `SELECT category FROM persons WHERE id = '67050b91-5011-4ba6-b230-9a387879717a'` = `'team'` (Umayr's enriched category survived).
- [ ] `SELECT category FROM persons WHERE id = '9e7c0448-dd3b-437c-9cda-c512dbc5764b'` = `'founder'` (Ramon).
- [ ] `SELECT COUNT(*) FROM observations WHERE evidence_pointer LIKE 'manifest://%' AND user_id = '…'` = 0 (stage-5 artifacts fully wiped).
- [ ] `SELECT COUNT(*) FROM observations WHERE evidence_pointer LIKE 'reingest-20260420://%' AND user_id = '…'` ≥ 1,500 (new clean cohort — choose a fresh evidence_pointer prefix in B2 to distinguish).

### 6.3. API + CLI
- [ ] `curl -H "Authorization: Bearer $ORBIT_API_KEY" http://localhost:3047/api/v1/person/67050b91-5011-4ba6-b230-9a387879717a/card | jq '.card.relationship_to_me'` starts with `"Close friend and tech peer"`.
- [ ] `curl -H "Authorization: Bearer $ORBIT_API_KEY" http://localhost:3047/api/v1/persons/enriched | jq '.persons | length'` = 2.
- [ ] `ORBIT_API_URL= orbit-cli orbit_observation_emit '{observation:{}}' 2>&1 | jq '.error.code'` = `"INVALID_INPUT"` (no stack trace).

### 6.4. Documentation
- [ ] `CLAUDE.md` contains no reference to "26 tests" or "Two routes. That's it." or "One table (`raw_events`) is source of truth" (reworded or removed).
- [ ] `agent-docs/README.md` contains rows for docs 12, 13, 14.
- [ ] `agent-docs/12-junk-filtering-system.md` has a "Status" banner at the top.
- [ ] `agent-docs/13-multi-tenant-onboarding.md` has a "Status: target design" banner.
- [ ] `agent-docs/03-current-state.md` data-state table references `observations`, `persons`, `person_observation_links` with post-cleanup counts.
- [ ] `outputs/verification-log.md` contains entries for Stage 4, 5, 5b, 5c.

### 6.5. Memory
- [ ] `/Users/sanchay/.claude/projects/-Users-sanchay-Documents-projects-personal-orbit/memory/` contains 6 new `tech_*.md` files (see D8).
- [ ] `MEMORY.md` index has 6 new bullets.

### 6.6. No backward-compat leakage
- [ ] `grep -rn "orbit-manifest-v2\.ndjson" scripts/ src/` returns **0 hits** (the v2 hardcode is gone everywhere).
- [ ] `grep -rn "sanchaythalnerkar@gmail.com" scripts/ src/ outputs/manifest-hypothesis-2026-04-19/ orbit-rules-plugin/` returns **0 hits** (hardcode replaced by env).
- [ ] `grep -rn "Appears in.*threads.*channels.*Pending enrichment" scripts/` returns **0 hits**.
- [ ] No commits contain "// removed", "_unused", "back-compat" comments (CLAUDE.md hard-cutover rule).

---

## 7. Estimated total effort

| Phase | Steps | Core hours |
|---|---|---|
| A — WA depth | A1 0.5 + A2 0.75 + A3 0.5 + A4 1.25 + A5 0.5 | **3.5 h** |
| B — Audit cleanup | B1 0.33 + B2 1.0 + B3 1.25 + B4 1.75 + B5 0.42 + B6 0.33 | **5.1 h** |
| C — Enrichment loop | C1 1.0 + C2 0.75 + C3 1.0 + C4 0.5 | **3.25 h** |
| D — Docs + memory | D1 0.33 + D2 0.75 + D3 0.25 + D4 0.17 + D5 0.33 + D6 0.17 + D7 0.25 + D8 0.5 | **2.75 h** |
| **Subtotal (focused work)** | | **14.6 h** |
| Review/approval waits (estimated) | | **1.5 h** |
| Pre-wipe dump + re-ingest runtime | | **0.5 h** |
| Test stabilization buffer (10%) | | **1.5 h** |
| **Total wall-clock** | | **~18 h** (2 working days) |

If a single operator works without interruption and the reviewer is available for gate approvals within 30 min of ask, 2 working days is realistic. If gates queue for hours, 3 working days. If decisions D1-D8 require back-and-forth discussion, add another half-day for alignment.

---

## 8. What this plan deliberately leaves out

- Stage 6 LLM enrichment itself (that's the next plan, not this one — the current plan only closes the loop so enrichment lands cleanly).
- Layer 2 blocklist table + admin CLI verbs from doc 12 (design-only in this cycle; next tranche after enrichment lands).
- Layer 3 self-writing heuristics (depends on Layer 2).
- Multi-founder signup UI / API-key minting UI from doc 13.
- A `/api/v1/persons` full read endpoint (only the `enriched` subset in C1 is needed for the loop).
- The `openclaw agent --verbose --json` observability layer (tracked as memory entry D8 #4).
- CI on this repo (tracked as memory entry D8 #3).

If any of these become load-bearing between now and execution, they become a sibling plan, not an amendment here.

---

## 9. Pointers for the executor

When executing this plan:

- Start every session by re-reading this file top to bottom — do not work from memory.
- For any decision point D1–D8 marked `default`, the default is what ships unless the reviewer left a note in the plan file itself.
- Commit per-step, not per-phase. Each commit message references the plan step id (e.g., `feat(orbit-rules): A1 — safety.mjs with six drop rules`).
- Before running any SQL in Phase B3, paste the exact query into this comment thread for reviewer approval. No dry-running from memory.
- Do not SSH to claw for any write operation (including env file edits) without explicit approval. Reads OK.
- If any acceptance criterion in §6 fails after step completion, stop — do not proceed to the next step.
- Land the verification-log entry (D7) as part of the last commit. Every cleanup step's evidence lives there.

---

_End of plan. Awaiting reviewer sign-off on §5 decisions D1–D8 before execution begins._
