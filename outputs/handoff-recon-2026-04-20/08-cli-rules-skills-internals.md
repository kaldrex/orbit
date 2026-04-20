# Non-Next.js surfaces: orbit-cli-plugin · orbit-rules-plugin · orbit-claw-skills

Recon pass 2026-04-20. No modifications, no commits.

Scope: the three OpenClaw-hosted surfaces that live outside the Next.js app and form the write-path into Orbit.

```
orbit-cli-plugin/      (plumbing — HTTP wrapper, no LLM)
orbit-rules-plugin/    (deterministic rules — 10 lib modules, 5–7 exposed tools)
orbit-claw-skills/     (LLM workflows — observer / resolver / enricher)
```

All three are registered with OpenClaw via `openclaw.plugin.json` + `index.js` that uses `definePluginEntry` (aliased as `t` in the bundled runtime; both plugins glob `/usr/lib/node_modules/openclaw/dist/plugin-entry-*.js` and `/opt/homebrew/lib/...` to survive hash rotations).

Each tool `execute()` returns an MCP envelope: `{content: [{type:"text", text: JSON.stringify(result)}]}`. The agent is expected to parse the text as JSON — the envelope is shape-invariant.

---

## 1. orbit-cli-plugin

### Files

| File | Purpose |
|---|---|
| `index.js` | Registers 4 tools with OpenClaw. Wraps `client.mjs` functions. |
| `lib/env.mjs` | Reads `ORBIT_API_URL` + `ORBIT_API_KEY`. Strips trailing slashes. Returns `{ok, config?, error?}` envelope. |
| `lib/schema.mjs` | Mirror of `src/lib/observations-schema.ts`. Zod discriminated union over 5 kinds. Constants: `OBSERVERS=["wazowski"]`, `MAX_BATCH=100`, `UUID_RE`. |
| `lib/errors.mjs` | 12-code taxonomy + factories (`validationError`, `httpError`, `networkError`, `invalidUuidError`, `maxBatchExceededError`, `fileNotFoundError`, `emptyFileError`, `invalidInputError`). |
| `lib/client.mjs` | Pure-plumbing HTTP functions. `joinUrl()` centralizes the "never re-prepend /api/v1" gotcha. No retries. |

### Verbs (4 tools — `openclaw.plugin.json` only lists 3; `persons_list_enriched` was added later and the manifest is stale)

| Verb | Signature | Returns on success | Error codes it can emit |
|---|---|---|---|
| `orbit_observation_emit` | `{observation, dry_run?}` → POST `/observations` (single-envelope array) | `{ok, accepted, inserted, deduped}`; in dry-run `{ok, dry_run:true, would_insert:1, validation:{passed:true}}` | `INVALID_INPUT` (missing/array observation), `VALIDATION_FAILED` (zod), `AUTH_FAILED`, `RATE_LIMITED`, `SERVER_ERROR`, `NETWORK_ERROR`, `BAD_REQUEST` |
| `orbit_observation_bulk` | `{file_path, concurrency?=1, dry_run?}` → streams NDJSON, chunks to `MAX_BATCH=100`, sequential POST | `{total_lines, batches_posted, total_inserted, total_deduped, failed_batches[]}` where each failed batch may carry `failed_observations[]` from per-line re-issue on HTTP 400 | `FILE_NOT_FOUND`, `EMPTY_FILE`, `INVALID_INPUT` (concurrency!=1), plus all of `emit`'s HTTP codes per-batch |
| `orbit_person_get` | `{person_id}` → GET `/person/:id/card` | raw body (the Next route's JSON — `{card: ...}`) | `INVALID_UUID`, `NOT_FOUND`, `AUTH_FAILED`, `NETWORK_ERROR` |
| `orbit_persons_list_enriched` | `{cursor?, limit?}` → paginates GET `/persons/enriched`, max 10 pages | `{persons[], warnings?:[{code:"PAGINATION_CIRCUIT_BREAK",...}]}` | `INVALID_INPUT` (env not set), `AUTH_FAILED`, `NETWORK_ERROR` |

### Error taxonomy (12 codes — `lib/errors.mjs`)

`VALIDATION_FAILED · AUTH_FAILED · NOT_FOUND · RATE_LIMITED · SERVER_ERROR · NETWORK_ERROR · INVALID_UUID · MAX_BATCH_EXCEEDED · FILE_NOT_FOUND · EMPTY_FILE · BAD_REQUEST · INVALID_INPUT`

Error shape:
```
{error: {code, message, suggestion, body_preview?, details?, http_status?}}
```
Stable `code` is what the agent pattern-matches on — `message` is free text. `suggestion` is one-liner prose the skill can pipe to Sanchay.

### Notable mechanics

- **`joinUrl(base, relPath)`** (`client.mjs:44-47`) is the single gotcha-gate. The configured base MUST already end in `/api/v1`; the tools pass `/observations`, `/person/:id/card`, `/persons/enriched` as relative paths.
- **400-only per-line isolation** (`isolateBatchFailures`, `client.mjs:131-165`). 5xx and network errors remain whole-batch — intentional, to avoid amplifying server load.
- **NDJSON parse errors appear as synthetic `failed_batches` entries** with `batch_index: -1, http_status: 0, code: "VALIDATION_FAILED"`. Real batches start at `batch_index: 0`. Merging the two into one array makes the count-of-failures easy; telling them apart requires reading `batch_index`.
- **`orbitPersonsListEnriched` has a different cfg-unwrap path** from the other three (`client.mjs:403-421`) — it accepts either a raw `{url,key}` or an `{ok, config}` envelope. The other three assume the caller already passed `config` straight through. This is an asymmetry the next refactor should collapse.
- **`OBSERVERS = ["wazowski"]`** is hardcoded. Any expansion to other claws requires a code change.

---

## 2. orbit-rules-plugin

Ten lib modules; only seven are surfaced as OpenClaw tools (the plugin manifest names five, `index.js` registers seven). `safety`, `name`, `group-junk` are library-only — called from scripts/tests but not exposed as tools because they require shaped data (not single strings).

### Module table

| Module | Purpose | Input shape | Output shape | Notable case |
|---|---|---|---|---|
| `phone.mjs` | Canonicalize phone → E.164 via `libphonenumber-js`. Strips `@s.whatsapp.net`/`@lid`/`@g.us` suffixes. | `{phone, default_country?}` | `{e164, country_code, valid, original}` | WA jids (11-15 digit strings) are parsed by prepending `+`; falls back to `default_country` (env `ORBIT_RULES_DEFAULT_COUNTRY` or `IN`) only if that fails. |
| `email.mjs` | Lowercase + strip `+suffix` + fold `googlemail.com` → `gmail.com`. Gmail-family drops dots in local-part. | `{email}` | `{canonical, domain, valid, original}` | Only applies dot-stripping to `gmail.com`/`googlemail.com`. Non-Gmail keeps dots. |
| `domain.mjs` | Classify domain as `personal\|work\|bot\|saas\|press\|other`. Corpus from `data/domains.json`. | `{domain, localpart_for_bot_check?}` | `{class, confidence, evidence}` | Compound bot-localpart regex (`noreply`, `alerts`, `mailer-daemon`, etc.) checked even when domain isn't on the bot list. Fallback: corporate-shaped `x.y.tld` → `work` @ 0.6. |
| `lid.mjs` | LID→phone via `~/.wacli/session.db.whatsmeow_lid_map`. Also exports `phoneForContact` (positive-source LID rule) and `isResolvableLidContact` (seed filter). Caches DB handles keyed on mtime. | `{lid, lid_map_source?, db_path_override?}` | `{phone, source_path}` | `contacts.phone` is *ignored* for `@lid` jids — verified 9,948 rows re-echoed LID digits as phone in Sanchay's wacli DB. Only `whatsmeow_lid_map` is authoritative. |
| `fuzzy.mjs` | Jaro-Winkler + token-set-sort, returns `max` of the two. | `{name_a, name_b}` | `{score, reason}` | `score = max(jw, ts)` with `reason` pointing at which won. Tokens are NFKD-normalized + diacritic-stripped before comparison. |
| `forwarded.mjs` | Strip Gmail forwarded-chain display-name pollution. Corpus-driven vendor check. | `{from_name, from_email, subject}` | `{cleaned: string\|null}` (returns `null` when name should be dropped) | If `from_name` matches a SaaS vendor AND `from_email` domain does NOT match that vendor, drop the name (let caller fall back to email localpart). Also handles "X via Y", "X on behalf of Y", `(Vendor)` trailing parens. |
| `bridge.mjs` | Layer-2 WA↔Gmail fuzzy-name merge decision. Only engages when one bucket is WA-only and the other Gmail-only. Uses `fuzzy` + generic/vendor blocklists. | `{bucket_a, bucket_b, threshold=0.85, single_token_threshold=0.92}` | `{merge, score, reason, wa_side_key?, gmail_side_key?}` | Multi-token names require `≥2 shared tokens` after normalization — prevents "Umayr Sheik" + "Umayr Khan" merging on token-set alone. Google Contacts buckets count as WA-side. |
| `safety.mjs` | Boolean predicates + `safetyDropReason()` aggregator. Seven reasons in fixed precedence. | `{name, emails?, phones?}` | `string \| null` (first matching reason code) | Precedence: empty > phone > unicode-masked > email > quoted > bot > test-leak. Unicode mask regex covers `\u2022 \u2219 \u00B7 \u30FB` (real mask chars found in the DB). |
| `name.mjs` | `pickBestName(candidates[])` — priority-ranked + length-tie-break name picker. Also `collectMessageSenderNames(db, jid)` SQL helper against `messages` table. | `[{source, name}]` | `string \| null` | Priority: `wa_contact(100) > google_contact(90) > gmail_from(80) > gmail_to_cc(70) > wa_group_sender(60) > wa_message_sender(55) > unknown(0)`. Ties broken by longer string (keeps "Umayr Sheik" over "Umayr"). |
| `group-junk.mjs` | Advisory-only group classification. `mega_lurker` / `broadcast_ratio` / `commercial_keyword`. | `{member_count, self_outbound_count, sender_counts, group_name}` | `{junk, reasons[], max_confidence}` | Mega-lurker = `member_count > 200 AND self_outbound === 0`. Broadcast = top sender > 80% of total when total > 10. Callers annotate but do NOT auto-exclude. |
| `data/domains.json` | Corpus for `domain.mjs`, `forwarded.mjs`, `bridge.mjs`. Keys: `personal`, `bot`, `saas`, `press`, `bot_patterns`, `bot_subdomain_prefixes`, `saas_vendor_names`, `saas_vendor_domains`, `generic_first_names`. | n/a | n/a | Loaded at module-require time via `readFileSync`. No hot-reload. Any edit requires a runtime restart. |

### Tools vs modules

The `openclaw.plugin.json` says 5 tools; `index.js` actually registers 7:
- `orbit_rules_normalize_phone`, `orbit_rules_canonicalize_email`, `orbit_rules_domain_class`, `orbit_rules_lid_to_phone`, `orbit_rules_fuzzy_match` (documented)
- `orbit_rules_strip_forwarded_chain_name`, `orbit_rules_cross_channel_bridge`, `orbit_rules_phone_for_contact`, `orbit_rules_is_resolvable_lid_contact` (undocumented in manifest)

The manifest is stale. The SKILL.md at `orbit-rules-plugin/skills/SKILL.md` also only documents 5. If a consuming skill reads the manifest to discover tools, the bridge / forwarded-strip tools are invisible.

---

## 3. orbit-claw-skills — SKILL.md inspections

### Common structure

Every SKILL.md uses the OpenClaw frontmatter (`name`, `description`, `metadata.openclaw.emoji`) followed by these sections: **When to use / When NOT to use / Safety / Your tools / Order of operations / Envelope spec / Confidence scale / Final log line / Worked example**.

They're not system prompts in the traditional sense — they're markdown files OpenClaw loads and prepends as instructions when the skill is invoked. Tools are referenced by name; the runtime exposes them as function calls.

### orbit-observer — `🔭`

- **Purpose:** Single-seed scan. Input = one seed (jid / phone / email). Output = observations emitted via `orbit_observation_emit`.
- **Tool footprint:** 5 rules tools + 3 CLI tools (`emit`, `bulk`, `person_get`) + `wacli`/`gws` skills.
- **Evidence construction:**
  - `evidence_pointer` uses URI-shaped strings: `wacli://messages/rowid=<N>`, `gmail://message-id/<rfc822-id>`, `wacli://contacts/jid=<jid>`, `gmail://from/<canonical-email>`, `google-contacts://resourceName/<name>`. No free-form prose.
  - `reasoning` is prose describing what was observed and why the kind/category/topic was picked.
- **Emission rule (load-bearing):** ONE `kind:"interaction"` observation per thread, N participants in `payload.participants[]`. Never N-per-thread. This is the KNOWS-edge invariant.
- **Confidence ladder** (0.95 / 0.85 / 0.7 / 0.5) is encoded in the prompt — the skill self-scores.
- **Safety drops** are re-stated inline even though `safety.mjs` exists — the skill is expected to redundantly enforce (phone-as-name, email-as-name, bot names, `List-Unsubscribe` / `Precedence: bulk` / `List-Id`).

### orbit-resolver — `🧩`

- **Purpose:** Consume observations from basket, cluster into persons, emit `kind:"merge"` / `kind:"split"` observations.
- **Tool footprint:** `normalize_phone`, `canonicalize_email`, `lid_to_phone`, `fuzzy_match`. No direct DB access — but the prompt does contain a hand-wavy instruction to "insert into the `persons` table via Supabase RPC" which violates the "API is the only writer" rule. See *weakest smell* below.
- **Four-layer waterfall:**
  1. Deterministic (phone/email/lid exact match) — free, confidence 1.0.
  2. Heuristic fuzzy name ≥0.9 auto; 0.6–0.9 → Layer 3; <0.6 dropped.
  3. LLM disambiguation — the only layer that costs tokens; confidence 0.85.
  4. Human escalation (Decision Tinder stub, currently just "log and skip").
- **Evidence construction:** `evidence_pointer` uses `merge://<join-key-1>+<join-key-2>...` (sorted). `deterministic_bridges[]` carries stable strings: `phone:+...`, `email:...`, `lid:...`.
- **Pseudocode algorithm is embedded in the SKILL.md** — treat it as a specification the model is expected to execute literally, not a high-level suggestion.

### orbit-enricher — `🪶` (bonus, not in brief)

- **Purpose:** Re-emit `kind:"person"` observations for persons whose cards are skeletons (`category:"other"` + null relationship).
- **Tool footprint:** `normalize_phone`, `canonicalize_email`, `domain_class`, `orbit_person_get`, `orbit_observation_emit`, `wacli`/`gws`.
- **Caps baked into the prompt:** 3 phones × 30 messages, 3 emails × 10 lists × 5 fetches, 200 chars/message, 500 chars/Gmail snippet. Exists to bound LLM context cost per person.
- **Invariants:** one observation per person per batch; never mutate phones/emails; name only changed when "clearly garbage."
- **Evidence pointer:** `enrichment://stage-6-2026-04-20/person-<person_id>` — encodes run-id so reruns are dedupable.

### orbit-rules SKILL.md (the rules-plugin-internal one)

Short meta-SKILL inside `orbit-rules-plugin/skills/`. Meant to teach consuming skills when to invoke each of the 5 documented rule tools. Doesn't mention the 4 undocumented ones.

---

## 4. Undocumented invariants (would cost an hour to discover)

These aren't in the docs but are load-bearing:

1. **`t` alias for `definePluginEntry`.** OpenClaw's bundled runtime exports `definePluginEntry` as `t` (minification artifact). Both plugins glob for `plugin-entry-*.js` and destructure `{ t: definePluginEntry } = require(...)`. If OpenClaw restructures its dist output, both plugins break identically. There is no API stability contract here.
2. **MCP envelope shape.** Every tool wraps return value as `{content: [{type:"text", text: JSON.stringify(result)}]}`. Skills are implicitly expected to parse. If you add a tool and return the raw object, it will silently deserialize as a JSON string in the model's context.
3. **`batch_index: -1` sentinel** for NDJSON parse-error rows synthesized into `failed_batches[]`. Real batches start at 0. Downstream log consumers that trust `batch_index` as an array offset will confuse themselves.
4. **Corpora are require-time loaded.** `domains.json` is `readFileSync`'d at module-import by three modules (`domain.mjs`, `forwarded.mjs`, `bridge.mjs`). Hot-edit means nothing until the plugin restarts.
5. **DB handle cache invalidation by mtime.** `lid.mjs` caches the session.db handle and re-opens only when mtime changes. During a long-running claw process, if someone `cp` overwrites the file with a stale mtime, the old cache wins.
6. **`OBSERVERS = ["wazowski"]` enum lives in TWO places:** `src/lib/observations-schema.ts` (server) and `orbit-cli-plugin/lib/schema.mjs` (client). Schema drift between the two is silent until a new observer tries to post.
7. **Rules-plugin manifest lists 5 tools; index.js registers 7.** Tool-discovery consumers that introspect the manifest will miss `strip_forwarded_chain_name`, `cross_channel_bridge`, `phone_for_contact`, `is_resolvable_lid_contact`.
8. **`orbit_rules_is_resolvable_lid_contact` tool is a degenerate wrapper** — the plugin runtime "can't pass a live Map," so the tool always invokes `isResolvableLidContact(row, null)` with a null lidMap. Callers needing the real behavior must import the lib function directly (inline). The tool is near-useless as-is.
9. **`google_contact` is counted as a WA-side signal** in `bridge.mjs` because Sanchay's Google Contacts are phone-keyed. This is non-obvious from the function name `hasOnlyWaSources`. Changes to Google Contacts collection (e.g. adding email-first sync) will break the bridge logic.
10. **Name source priority ties break on longer-string.** `pickBestName` sorts by rank desc, then length desc. This intentionally prefers "Umayr Sheik" over "Umayr" at the same source, but it also means a verbose junk name ("Umayr — reachable weekdays 9-5") would beat the clean version if both arrive from the same source.
11. **KNOWS-edge rule is prose-only.** orbit-observer's §6 says "ONE `kind:"interaction"` per thread" but nothing in the plugin, schema, or server enforces it. An observer regression producing per-participant interactions would pass validation.

---

## 5. Weakest-smelling part

The **orbit-resolver SKILL.md** tells the model: *"Create person rows by inserting into the `persons` table via Supabase RPC — not a direct INSERT"* (line 24). This contradicts the `project_api_is_only_writer.md` invariant that says **nothing** bypasses HTTP. There's no resolver-facing API route for writing persons today — persons are materialized server-side by the `upsert_observations` RPC when observations post. Either the SKILL is describing an obsolete path, or it's telling the model to do something the architecture explicitly forbids. Either way it will confuse any model that reads both `CLAUDE.md` and this SKILL.

Closely tied: the resolver SKILL's algorithm pseudocode (§Algorithm) describes direct-DB-style operations (`link(obs.id, best_bucket.person_id)`) with no corresponding CLI verb. There's no `orbit_observation_emit(kind:"merge")` walk-through matching the pseudocode. The skill works because the model fills in the gap — but this is exactly the kind of drift that produces silent failures.

---

## 6. Bonus: the three surfaces contract-side-by-side

```
Skill prompt                       Rule tool (deterministic)           CLI tool (plumbing)          Server route
----------------------------      --------------------------------    -------------------------   ---------------------------
orbit-observer.SKILL.md           orbit_rules_normalize_phone          orbit_observation_emit      POST /api/v1/observations
                                  orbit_rules_canonicalize_email       orbit_observation_bulk      (zod-validated, upserts
                                  orbit_rules_domain_class                                         persons via RPC)
                                  orbit_rules_lid_to_phone
                                  orbit_rules_fuzzy_match

orbit-resolver.SKILL.md           (same subset)                        orbit_observation_emit      POST /api/v1/observations
                                                                       orbit_person_get             GET /api/v1/person/:id/card

orbit-enricher.SKILL.md           orbit_rules_normalize_phone          orbit_person_get             GET /api/v1/persons/enriched
                                  orbit_rules_canonicalize_email       orbit_observation_emit      POST /api/v1/observations
                                  orbit_rules_domain_class             orbit_persons_list_enriched
```

All paths end at HTTP. There is no plugin-to-DB path. The resolver SKILL's "insert via Supabase RPC" line is the one exception — and it's vestigial.
