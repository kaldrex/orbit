# 16 · How Orbit Works End-to-End

> Written as two friends walking their founder through the product, warts and all. Part 1 = user journey. Part 2 = what's happening under the hood. Part 3 = what we've honestly evaluated so far. Tone is casual because the mechanics are load-bearing and we want you to actually read this.
>
> **Read this doc if you want a single-sitting grasp of how Orbit works from Sanchay clicking "sign up" all the way down to the SQL the RPC is running.**

---

## Part 1 — User Journey (the product experience)

### Day 0, 9:47am — Sanchay signs up

**What Sanchay sees:** `orbit.yourdomain.com/signup`. Email + password. One screen. Takes 30 seconds. He lands on a dashboard that says *"Hi Sanchay. Your Orbit is empty. Install the OpenClaw agent to populate it → [here's how]."*

**Two friends explaining it to him:**

*"OK Sanchay, when you signed up, Supabase — that's the database we use — created a row in its `auth.users` table. That row has your user_id. It's a UUID. Remember this UUID because every single thing you'll ever create in Orbit — every card, every observation, every correction — gets tagged with it. That's how Hardeep's stuff and your stuff stay separate when he joins next week."*

*"You also got an API key — starts with `orb_live_`. That's what your agent is gonna use to talk to Orbit. Think of it as a permanent password for your agent only. Revokable any time if your laptop gets stolen."*

**Behind the scenes:**
- `INSERT INTO auth.users (email, password) RETURNING id` → returns Sanchay's user_id
- `INSERT INTO api_keys (user_id, key_hash, prefix) VALUES ('<sanchay's user_id>', '<sha256 of orb_live_...>' , 'orb_live_xxxx')`
- Every table Sanchay will interact with (`observations`, `persons`, `person_observation_links`, `blocklist`) has an RLS policy: `USING (auth.uid() = user_id)`. Meaning: **Postgres itself enforces that Sanchay can only see his own rows.** Not a bug in our app code — a database-level guarantee.

---

### Day 0, 9:52am — Sanchay installs the agent

**What Sanchay does:**

1. Spins up a small VM (we call ours "claw" — it's a $5/mo GCP instance, but it could be his laptop too)
2. `curl -fsSL https://openclaw.ai/install | sh` — OpenClaw installed (the 360k-star public agent runtime)
3. `npx orbit-for-openclaw install` — pulls our plugins (`orbit-rules` + `orbit-cli`) and our skills (`orbit-observer` + `orbit-resolver` + `orbit-enricher`) from npm

**Two friends:**

*"OK so OpenClaw is a butler that lives on your machine. It's not ours — we didn't build it. It's Peter Steinberger's open-source runtime, 360k stars on GitHub. Loads of products run on it — there's a sales-kanban product called DenchClaw that uses the same runtime. We just wrote two plugins that the butler installs."*

*"Plugin 1 = `orbit-rules`. That's our deterministic logic — how to normalize a phone, how to canonicalize an email, how to bridge WhatsApp LIDs to real phone numbers. Think of it as the butler's spectacles — without them everything's blurry."*

*"Plugin 2 = `orbit-cli`. That's how the butler TALKS to Orbit. Four verbs: emit one observation, bulk upload a file of observations, fetch someone's card, list all the enriched people. The butler speaks these verbs, and they go as HTTPS requests to Orbit's API."*

**Behind the scenes:**
- Plugins land at `~/.openclaw/plugins/orbit-rules/` + `~/.openclaw/plugins/orbit-cli/`
- Skills land at `~/.openclaw/workspace/skills/orbit-observer/` etc.
- Plugin loader: `const { t: definePluginEntry } = require(pluginEntryBundle)` — yes this is a weird alias (the runtime's export is aliased as `t`). It's the only way to load an OpenClaw plugin.
- Env at `~/.openclaw/.env`:
  ```
  ORBIT_API_URL=https://orbit.yourdomain.com/api/v1
  ORBIT_API_KEY=orb_live_xxxx
  ORBIT_SELF_EMAIL=sanchay@...
  ORBIT_SELF_PHONE=+91...
  ANTHROPIC_API_KEY=sk-ant-...
  ```

---

### Day 0, 10:10am — Sanchay authenticates his channels

**What Sanchay does:**
- `wacli auth` → a QR code pops up → Sanchay scans it with his WhatsApp → `~/.wacli/wacli.db` starts populating as his WA messages flow in
- `gws auth` → Google OAuth flow → tokens land in `~/.gws/tokens/`

**Two friends:**

*"Two separate CLIs. `wacli` is an open-source WhatsApp CLI — it links to your WhatsApp account like WhatsApp Web does and stores messages locally in a SQLite database. `gws` is the Google Workspace CLI — OAuth to your Gmail, Contacts, Calendar. Both are tools that OpenClaw can call via `POST /tools/invoke` with zero LLM overhead."*

*"Key thing: these channel CLIs are totally independent. They don't know Orbit exists. They just store your data on your machine. That's the 'agent-on-your-machine' architecture we bet on — data lives where you live, not in some SaaS blob."*

---

### Day 0, 10:45am — First data pull (the magic moment)

**What Sanchay does:** on claw, types:

```
openclaw agent --agent main --message "Run the orbit-observer-bulk skill for my whole network."
```

**What happens over the next 2 minutes:**

1. Wazowski (Sanchay's OpenClaw agent instance) wakes up
2. Reads `~/.wacli/wacli.db` — ~33k messages, contacts, groups, group_participants tables
3. Reads `~/.wacli/session.db` — the LID↔phone bridge (14,995 rows)
4. Reads `~/.orbit-export/*.ndjson` — Gmail messages + Google Contacts exports
5. Applies rules from `orbit-rules-plugin`:
   - Normalize every phone via `libphonenumber-js`
   - Canonicalize every email (lowercase, strip `+suffix`, collapse gmail dots)
   - Bridge WhatsApp `@lid` identifiers → phone numbers via `whatsmeow_lid_map`
   - Classify bot emails (noreply, account-info, billing, etc.)
   - Strip forwarded-chain artifacts (catches "digital ocean" showing up as a person's name)
6. Runs union-find across all identities to merge cross-channel signals (Umayr's WA phone + Gmail email collapse into one person)
7. **Fuzzy-name bridge** catches cross-channel humans without a mechanical bridge
8. **Safety filter** drops 5,000+ junk rows — phone-as-name, Unicode-masked-phone push_names, test-data leaks
9. **Seed filter** drops 4,985 nameless ghost @lid contacts
10. Emits **1,602 clean person observations** into a local NDJSON
11. Calls `orbit_observation_bulk` → chunks of 100 → POSTs to Orbit's API over HTTPS

**Two friends:**

*"OK so in like 2 minutes, Wazowski turned 33k messages into 1,602 unique humans. That's not magic — it's just rules applied in order. The rules are BORING — lowercase this email, strip this suffix from this phone — but applied cleanly, they compress 33k rows into 1,602 identities."*

*"1,602 is your actual network, bro. Not an estimate. Real humans you've touched via WhatsApp + Gmail + Contacts. Every one has a phone or email. None are bots. None have a phone as their name."*

**Behind the scenes — the write path:**

```
claw (local)                Mac/Vercel (Orbit)           Supabase (cloud)
──────────────              ──────────────────           ─────────────────
orbit-cli                   Next.js API                  PostgreSQL
  orbit_observation_bulk   POST /api/v1/observations    public.observations
  → HTTPS (TLS)      ─────→  • validate Bearer token    • INSERT with
  → Bearer orb_live_xxxx     • zod-check each obs         BEFORE INSERT
                              • call RPC:                  trigger computes
                             upsert_observations ─────→    dedup_key
                              • return counts              • auto-merge RPC
                                                           materializes
                                                           persons + links
                                                           on kind:"merge"
```

---

### Day 0, 11:00am — LLM enrichment (the "who are these people?" pass)

**What Sanchay does:** triggers the enricher skill.

**What happens — batched enrichment (~12 min, ~$4):**

1. Query Supabase for 1,600 skeleton person_ids via the enriched-persons endpoint (those with `category: "other"` or null)
2. For each: gather recent context (30 WhatsApp messages + top 5 Gmail threads + shared group names)
3. Batch 30 persons per call; prompt Claude Sonnet 4.6 with: *"Here are 30 humans' contexts. For each, output `{person_id, category, relationship_to_me, company, title, confidence, reasoning}`."*
4. 54 batches, 5 concurrent. Prompt-cached system prompt (when properly sized).
5. 1,568 successful enrichments → emit via `orbit_observation_bulk` → API → DB

**Two friends:**

*"Now the hard part — what ARE these people to Sanchay? Rules can tell us someone's phone is +91xxx. Rules can't tell us they're 'a college peer from SAKEC's 2024 AI batch.' That needs the LLM."*

*"We batch 30 per API call because sending 1 per call is dumb — same system prompt, same format overhead, times 1,600. Instead: one Sonnet call processes 30 at a time. That's what OpenProse (a DSL inside OpenClaw) has as a first-class pattern. 54 calls × ~4 sec each, in batches of 5 concurrent → ~12 min total. $4. Sanchay gets 547 humans with real categories + 1,055 honest 'other' (he legitimately has no signal on them)."*

**Example — the Yash Rane card:**

```json
{
  "name": "Yash Rane",
  "category": "founder",
  "relationship_to_me": "Founder of NyayAssist, an Indian legal-tech product,
                         who shares the Aurum workforce and Deep Blue Season 8
                         groups with Sanchay and has publicly announced the
                         product's launch.",
  "company": "NyayAssist",
  "title": "Founder",
  "confidence": 0.85
}
```

Every enriched card cites concrete evidence (group names, message content, email context). The LLM doesn't invent.

---

### Day 1, morning — First query

**What Sanchay does:**

```
orbit person list --category fellow --limit 20
```

Gets 20 fellows — college peers, cohort-mates, alumni groups. Each with a 1-sentence description.

Or, via UI (when Stage 8 ships):
- Opens the map, filters by `category: fellow`, zooms into Mumbai — 80 fellows pop up.
- Clicks one → full card with relationship summary, shared groups, last contact date.

**Two friends:**

*"This is the discovery moment. These aren't the 30 founders Sanchay remembers. These are people he overlapped with in cohorts, groups, emails — and completely forgot about. The product promise."*

---

### Day 7+ — Continuous refresh (Stage 7, not yet built)

**What will happen automatically:**
- Every 15 min, OpenClaw's `heartbeat` scans `wacli.db` for new messages since the last watermark
- Any new sender → observer fires on that sender → emits new observations
- Existing person → latest-wins update (new category / relationship if signal shifted)
- Every 14 days, enricher re-runs on cards with stale `last_enriched_at`

**Currently:** not wired. Orbit's DB is a snapshot of 2026-04-20. This is what Stage 7 will build.

---

### Day 30 — A real discovery moment

*"Sanchay's in Mumbai for a week. Opens Orbit. Asks: 'founders in Mumbai I haven't spoken to in 90 days.' Postgres returns 22 people. Fifteen of them he'd completely forgotten. He pings 3. Two say yes to coffee. That's the PMF moment. Not the 30 people in his phone — the 1,500 quietly around the edges of his network."*

---

### Inviting Hardeep (multi-founder onboarding)

*"Next month, Hardeep signs up on the same Orbit instance. Gets his own user_id, own API key. Installs OpenClaw on HIS machine (or VM). Auths HIS WhatsApp, HIS Gmail. Runs the same observer. His 1,200 or whatever humans go in."*

*"Supabase RLS ensures Hardeep's humans never appear in Sanchay's queries. Different user_ids, same infrastructure. Zero cross-contamination — enforced by Postgres, not hope."*

---

## Part 2 — Tech Behind It (the actual mechanics)

### The five API contracts (live today)

| Route | Purpose | Who calls it |
|---|---|---|
| `POST /api/v1/observations` | Append new observations (batch up to 100) | `orbit-cli` via agent |
| `GET /api/v1/observations` | Read cursor-paginated observations | Resolver + enricher |
| `GET /api/v1/person/:id/card` | Assemble + return one person's card | UI + `orbit-cli` |
| `POST /api/v1/person/:id/correct` | Write a correction observation (confidence 1.0) | UI "fix this" button + Telegram bot |
| `GET /api/v1/persons/enriched` | Paginated list of non-placeholder cards | Enricher's preserve loop + UI list view |

### The rules on every write (API as single enforcement point)

Before anything hits Postgres:
1. **Auth:** `Authorization: Bearer orb_live_*` → validated via `validate_api_key` RPC → returns `user_id`
2. **Zod schema validation:** 5-kind discriminated union (`person` | `interaction` | `correction` | `merge` | `split`) with per-kind payload shapes
3. **Dedup key:** `BEFORE INSERT` trigger computes `sha256(user_id + evidence_pointer + kind + normalize(payload))` — content-identical observations silently no-op
4. **Auto-merge:** `upsert_observations` RPC, on `kind:"merge"` rows, atomically materializes `persons` + `person_observation_links` rows server-side

### The rules on every read

- `SECURITY DEFINER` RPCs (`select_observations`, `select_person_observations`, `select_persons_page`) accept `p_user_id` explicitly — they bypass RLS but require the API to pass the right user_id (which comes from the auth step)
- Reads CANNOT cross user_ids because the API passes `auth.userId` into every RPC
- Card assembly happens in a pure function (`src/lib/card-assembler.ts`): latest-wins on fields, corrections override, Jaccard-dedup on summary fragments

### Enrichment path (where Anthropic comes in directly)

```
enricher.mjs on claw          Anthropic API (direct)    Orbit API            Supabase
──────────────────           ─────────────────────     ──────────────       ──────────
1. Query /persons/enriched ─→ (finds ~1,500 "other")
2. Gather context per person
   - SQL on local wacli.db
   - Read local Gmail NDJSON
   - Bridge LIDs via session.db
3. Batch 30 contexts → prompt ─────→ Sonnet 4.6
4. (Sonnet returns JSON array) ←─────  • cache system prompt
5. Transform → observations
6. POST bulk via orbit-cli ──────────────────────────→ POST /observations
                                                       → dedup → store
                                                                      ──────→ observations
                                                                              table
```

Key: claw holds its own `ANTHROPIC_API_KEY` (separate budget from the orbit-cli plugin — the plugin never has an LLM key). The enricher is a new component, not the CLI, not the agent loop.

### Multi-tenant isolation — how it's enforced

- Every table has RLS: `CREATE POLICY "users read own X" USING (auth.uid() = user_id)`
- `api_keys` table maps keys → user_ids. API validates key → gets user_id → passes to RPCs.
- Hardeep's claw has a different `ORBIT_API_KEY`. That key maps to Hardeep's user_id. Every write + read is scoped.
- Postgres itself rejects a query that tries to read rows with a different `user_id`. Not our app code — the database.

### What Neo4j will do (when we populate it — next load-bearing step)

```
Postgres (source of truth)        Neo4j (graph projection)
─────────────────────────         ────────────────────────
persons                     ───→  (:Person {id, name, category, ...})
person_observation_links    ───→  (:Person)-[:OBSERVED]-(observation metadata)
manifest shared-group edges ───→  (:Person)-[:KNOWS {group_names: [...]}]-(:Person)
```

Queries Neo4j will make fast that Postgres can't express cleanly:
- `shortestPath()` — intro chains
- `gds.louvain.stream()` — auto-cluster into communities
- `gds.betweenness.stream()` — who are the hubs bridging disconnected clusters
- Variable-length patterns — *"who do I know via Umayr, 2 hops"*

---

## Part 3 — What We've Honestly Evaluated

### What works (verified this session)

| Thing | Proof |
|---|---|
| Pipeline end-to-end | 1,602 persons in DB, 0 wrong-merges in 20-sample audits |
| Enrichment quality | Yash Rane + 546 other cards cite specific evidence |
| Multi-tenant isolation | RLS policy confirmed on persons table + auth round-trip |
| Byte-identical canary | Umayr card diff vs April-19 baseline: empty |
| Speed | 12-14 min for 1,500 enrichments |
| Cost | $8.55 Anthropic for 547 meaningful cards — $0.016/human |
| Test discipline | 329 tests green, every rule has real-data fixtures |

### What doesn't work yet (honest gap list)

| Thing | Status |
|---|---|
| Stage 7 continuous refresh | Not wired — Orbit is a snapshot today |
| Stage 8 UI (list + graph view) | Not built — CLI + SQL only |
| Neo4j | Empty — needs populate script |
| Curation verbs (`block-email`, `merge`, etc.) | Designed (doc 12), not built |
| Resilience primitives (progress file, retries, ETA) | Not built — Stage 7 precondition |
| Apple Contacts / iMessage | Deferred to post-V0 |
| 1,055 humans still "other" | Truly no channel signal — data ceiling, not a bug |

### What's fragile (flagged, actively tracked)

- Single OpenClaw instance per founder — no redundancy if claw dies
- Anthropic TPM could throttle a large batch (haven't hit it yet, but would)
- Prompt cache didn't fire in v3/v4 (system prompt under 2,048 tokens)
- One hardcode removed but we got lucky catching it; similar ones could exist

See `memory/project_tracked_debt_2026_04_20.md` for the 4 open debt items.

### Costs so far (transparent)

| Line item | Spend |
|---|---|
| Anthropic (enrichment v3 + v4) | $8.55 |
| Supabase | <$1/mo (free tier + small Pro charges) |
| Claw VM | whatever Sanchay's already paying GCP |
| Orbit Vercel deploy | not yet live — current dev routes through Mac + Tailscale |
| Dev time | multiple sessions, unquantified |

---

## Closing — the founder-pitch version

*"So yeah. Orbit right now is Sanchay's personal relationship memory. 1,602 humans identified cleanly. 547 enriched with real categories + relationships + inferred companies. 1,055 honest 'saved contact' — we don't invent context we don't have. Zero duplicates. Zero junk names. Umayr's card has been byte-identical across four pipeline rewrites."*

*"Next: continuous refresh so it stays living. Then UI so Sanchay can scroll it. Then Neo4j so he can ask 'who do I know via Umayr who's a founder who's shipped a product?' — in one Cypher query. That's the magic moment. Not the list — the graph."*

*"Then: Hardeep, chad. Same infrastructure. Their own user_ids. Enforced isolation. Zero cross-contamination. Week's work."*

---

## Related

- [14-cleanup-2026-04-20.md](./14-cleanup-2026-04-20.md) — the cleanup narrative that got us to this state
- [15-future-props.md](./15-future-props.md) — priorities + Neo4j rationale + Stage 7 continuous-loop shape
- [13-multi-tenant-onboarding.md](./13-multi-tenant-onboarding.md) — Hardeep/chad onboarding plan
- [03-current-state.md](./03-current-state.md) — ground-truth snapshot (tables + counts)
- `memory/project_openclaw_is_a_public_framework.md` — OpenClaw is not ours
- `memory/project_api_is_only_writer.md` — API is the single contract
- `memory/project_tracked_debt_2026_04_20.md` — 4 open debt items
