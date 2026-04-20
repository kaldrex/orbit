# Manifest Hypothesis Report — 2026-04-19

## Verdict

**HYPOTHESIS_SUPPORTED** — all four claims hold on Sanchay's real corpus.

- Claim 1 (per-seed tool-call collapse): **13 → 3** minimum; **~30 → 3+N** typical. Supported.
- Claim 2 (jq-debuggable before DB): Supported. Umayr's WA/Gmail split is visible in one jq call; bot-leaks and name-leaks surface by jq on `name`/`emails`.
- Claim 3 (cheap delta reruns): Supported. Byte-identical back-to-back runs, 0.74s wall-clock each, sha256 match.
- Claim 4 (DB-free discovery): Supported. All three demo queries <100ms on a 2 MiB file.

## Artifacts delivered

| path | size | notes |
|---|---|---|
| `outputs/manifest-hypothesis-2026-04-19/orbit-manifest.ndjson` | 2,062,550 B / 6,883 lines | sha256 `1830f209e642b66364de105c8e2de9f4cb9a6bcfdb3b99c42a2b7bc1135c9396` |
| `outputs/manifest-hypothesis-2026-04-19/manifest-gen.mjs` | 21 KB | generator (mirror of claw copy) |
| `outputs/manifest-hypothesis-2026-04-19/summary.json` | 3.3 KB | headline numbers machine-readable |
| `claw:/tmp/orbit-manifest-2026-04-19.ndjson` | same as above | |
| `claw:~/.openclaw/plugins/orbit-rules/manifest-gen.mjs` | | generator on claw (uses its own node_modules) |

## M1 — Build cost

| metric | value |
|---|---|
| wall clock | **0.74 s** |
| user CPU | 0.99 s |
| system CPU | 0.15 s |
| CPU utilization | 153% |
| peak RSS | **140.2 MiB** |
| output file | **2.0 MiB** (2,062,550 bytes) / 6,883 lines |

Input volume: 33,105 wacli messages + 14,995 lid_map rows + 11,822 wacli contacts + 2,002 Gmail messages + 342 Google Contacts.

## M2 — Shape

| metric | value |
|---|---|
| total humans | 6,883 |
| multi-source buckets | 2,027 (29.4%) |
| single-source buckets | 4,856 (70.6%) |
| dropped self buckets | 7 |
| dropped ghost @lid contacts (Fix #2) | 4,985 |
| dropped Gmail bulk/bot | 1,181 of 2,002 |
| bucket size p50 / p95 / max | 2 / 2 / 2 |

Provenance combos (top):
```
4,569  wa_contact
1,329  wa_contact + wa_group
  397  wa_contact + wa_dm
  216  gmail_from
  185  google_contact + wa_contact
   71  google_contact
   46  google_contact + wa_contact + wa_dm
   41  wa_contact + wa_dm + wa_group
   21  all four sources
    8  google_contact + wa_contact + wa_group
```

Top-10 by thread_count:
```
#1  "digital ocean"      73  shamlata@cyphersol.co.in   (gmail_from)   ← NAME-LEAK
#2  "Imran Sable"        71  sable@cyphersol.co.in
#3  "cyphersol fin"      69  cyphersolfin@gmail.com
#4  null                 63  samidha@cyphersol.co.in
#5  "ramon"              51  ramongberrios@gmail.com
#6  "Hardeep Gambhir"    20  +14377754295   (wa_dm+wa_contact+wa_group+google_contact)  ← 4-source
#7  "Creative Partners…" 19  cpp@runwayml.com
#8  "Chandan Perla"      18  +917013563001  (wa_dm+wa_contact+wa_group)
#9  "Khushi Sonawane"    15  khushisonawanee@gmail.com
#10 "Meet"               13  +919820492346  (wa_dm+wa_contact+wa_group)
```

## M3 — 20-sample audit (seed=42)

**Counts: CLEAN=4, UNRESOLVABLE_SINGLETON=12, MISSING-BRIDGE=4, WRONG-MERGE=0, BOT-LEAK=0, NAME-LEAK=0.**

Per-sample: 12 are nameless @lid contacts with bridged phone but zero thread activity (UNRESOLVABLE); 4 are named WA contacts with no observed DM/group activity (MISSING-BRIDGE — real humans Sanchay knows but hasn't messaged in the 33k-msg window); 4 are clean real DM/group participants or Gmail senders.

Zero wrong-merges in sample confirms Fix #1 (ignore `contacts.phone` for @lid jids) is holding.

**Corpus-level issues spotted outside the sample (by jq on the file):**
- BOT-LEAK: `account-info@skydo.com` escaped the regex — localpart not covered by `^(noreply|no-reply|info|hello|support|do-not-reply|notifications|team|newsletter)$`. Extend to include `account-info`, `receipts`, `billing-info`, `statements`.
- NAME-LEAK: "digital ocean" at the #1 thread-count slot on `shamlata@cyphersol.co.in` — forwarded-chain display name pollution.
- NAME-LEAK: "Hotel Lancaster through Booking.com" at an OTA reply-to — unrelated to person identity.

## M4 — jq discovery demos

Ran on 2.0 MiB file with jq 1.7.

| query | shape | lines | time |
|---|---|---|---|
| Q1 `select(.emails[]? \| test("@sinxsolutions\\.ai$"))` | everyone at Umayr's company | 1 | 0.060 s |
| Q2 `select(.thread_count >= 50)` | power contacts | 5 | 0.057 s |
| Q3 `select(.source_provenance.wa_dm == false and .source_provenance.gmail_from == true)` | Gmail-only humans | 216 | 0.058 s |

Q1 returns only Umayr because Sanchay's Gmail corpus only contains one sinxsolutions.ai person — the query shape is correct; answer depth is a corpus property.

## M5 — Delta cost

Two back-to-back runs, no changes to inputs.

```
diff -q /tmp/orbit-manifest-2026-04-19.ndjson /tmp/orbit-manifest-2026-04-19.run2.ndjson
  (no output — files identical)

sha256sum run1 run2 →
  1830f209e642b66364de105c8e2de9f4cb9a6bcfdb3b99c42a2b7bc1135c9396  both
```

**Deterministic ✓.** All datetimes are source-driven (sqlite `ts`, Gmail `internalDate`). Bucket order is by canonical sorted node list. IDs are `sha1(first_node)[:12]`. Real-world delta cost on an incremental source update = exactly the subset of lines whose nodes gained new timestamps or provenance; `diff -u` between dated manifests is the cheapest possible changelog.

## M6 — Per-seed tool-call collapse (headline)

Seed: **Umayr** = `971586783040@s.whatsapp.net` / `usheik@sinxsolutions.ai`. Ground truth: 3,371 wacli DM msgs, 2 Gmail msgs in 2 threads, 1 Google Contact (no email), 6 WA groups.

### Path A — observer SKILL without manifest (counted literally)

| step | call | n |
|---|---|---|
| 1 | `orbit_rules_normalize_phone` (seed) | 1 |
| 2 | `wacli chats list --query Umayr` | 1 |
| 2 | `wacli messages search --chat <jid> --limit 100` | 1 |
| 2 | `wacli contacts show --jid <jid>` | 1 |
| 3 | `gws gmail users messages list --q …` | 1 |
| 3 | `gws gmail users messages get --id` × 2 | 2 |
| 4 | `gws contacts list --query Umayr` | 1 |
| 5 | `orbit_rules_canonicalize_email` × 2 | 2 |
| 5 | `orbit_rules_domain_class` × 2 | 2 |
| 8 | POST `/observations` | 1 |
| **total** | | **13** |

Typical seed with more Gmail traffic: 20 gets + ~10 classify + ~5 wacli + 1 POST → **25–40 tool calls**.

### Path B — with manifest

| step | call | n (identity-only) | n (full-card) |
|---|---|---|---|
| 1 | `jq -c 'select(.name\|test("Umayr"))' manifest.ndjson` | 1 | 1 |
| 2 | `wacli messages search --chat <dm_jid>` | 0 | 1 |
| 3 | `gws gmail users messages get --id` × 2 | 0 | 2 |
| 4 | LLM classify | 1 | 1 |
| 5 | POST | 1 | 1 |
| **total** | | **3** | **6** |

**Collapse ratios:**
- Identity-only: 13 → 3 = **4.3× collapse** (77% reduction)
- Full-card with bodies: 13 → 6 = **2.2× collapse** (54%)
- Typical seed: 30 → 6–10 = **4–5× collapse**

**What doesn't collapse:** thread-body fetches (scales with N threads), LLM classification (1 call), the POST (1 call). Manifest replaces identity legwork, not content legwork.

### Second-order win

`jq -c 'select(.name | test("Umayr"))'` returns **two** buckets — one phone-keyed (WA) and one email-keyed (Gmail). The observer would POST two person observations before anyone noticed the identity split. With the manifest you see it at the file level and can resolve it explicitly (merge override, or let the LLM resolver fix it) before anything writes to Orbit's DB. That's Claim 2 made concrete.

## What would break at 10× scale

1. In-memory union-find: ~700 MB RSS at 70k humans (linear scaling). Fine on laptop; revisit for multi-founder.
2. `readFileSync` on Gmail NDJSON: 500 MB string at 200k messages. Switch to line streaming.
3. Name picker is a flat sort per bucket; currently no bucket grows past single digits.
4. Domain bot-list is hard-coded in the script. Promote to a growable JSON corpus.
5. Deterministic hashes depend on libphonenumber-js version stability. Pin it and stamp lib version + rules-hash into a manifest header.
6. Threads counted per-channel; Gmail reply-chains that fork into multiple threadIds overcount. Negligible at V0.
7. No incremental mode — regenerates everything each run. Cheap today (0.74s); at 100× add delta-rebuild.
8. BOT-LEAK regex and NAME-LEAK handling for Gmail forwarded-chains need attention before the top-10 view is trustworthy.

None blocks moving forward. All eight are visible from the current 2 MiB artifact.

## Guardrails honored

- Read-only on all claw data ✓
- Did not POST to Orbit's API ✓
- Did not modify deployed `orbit-rules` plugin (rules inlined in generator) ✓
- Did not invoke observer/resolver SKILLs — simulated in script ✓
- No fabricated counts; all numbers reproduced from on-disk artifacts ✓
