# 04 — What to Fix Next (Priority Order)

## The one thing first: Canonical Identity Resolution

Everything else stacks on top of correctly identifying "this is the same human." Scoring is broken because duplicates dilute interaction counts. Going-cold is broken because Ramon's 145 WhatsApp interactions are on one node but his calendar meetings are on another. Categorization is broken because LLM sees contradictory context when duplicates exist.

**Fix this first. Every other fix gets easier after.**

## Phase 1 — Canonical Resolver (agent-side, LLM-powered)

### Design
Hybrid: deterministic rules first, LLM for the residue.

**Stage A — deterministic merges (runs in <1 second, no LLM):**
1. Merge all nodes sharing an exact email.
2. Merge all nodes sharing an exact phone number.
3. Merge when email local-part matches name (e.g. `ramongberrios@gmail.com` ↔ "Ramon Berrios" via SequenceMatcher > 0.85).
4. Merge single-first-name → full-name when first name is distinctive (>4 chars) and no conflict: "Suhas" → "Suhas Sumukh".
5. Merge last-initial abbreviation: "Ramon B" → "Ramon Berrios" if both share first name.

Port `CanonicalNameResolver` from `/Users/sanchay/Documents/projects/personal/localhost/.claude/worktrees/fervent-banach/orbit-experiment/intelligence_layer.py` to TypeScript. 8/8 accuracy validated against real data.

**Stage B — LLM judgment for what rules can't decide:**

1. Query Neo4j for all persons. For each node, build a context object:
   ```json
   {
     "id": "p_xxx",
     "name": "Imran Sir",
     "email": null,
     "company": null,
     "topChannels": ["whatsapp_dm"],
     "topInteractors": ["Sanchay", "Samidha", "Ramon B"],
     "firstInteraction": "2024-07-01",
     "lastInteraction": "2026-04-10",
     "interactionCount": 25
   }
   ```

2. Fuzzy-group candidates — only send to LLM pairs that share:
   - Same first name token (>2 chars), OR
   - Shared email domain, OR
   - Shared top interactor, OR
   - Name similarity > 0.7 via SequenceMatcher

   Cuts 1M pairs → ~5K candidate pairs → ~200 candidate clusters.

3. Batch clusters of ~20 candidates per LLM call. Prompt: "Return JSON array of clusters `{canonical_id, merge_ids[], confidence, reasoning}`. Only cluster when confident. Conservative default."

4. Accept merges with confidence ≥ 0.8 AND at least one shared identifier OR strong contextual match.

5. Apply merges via Cypher:
   ```cypher
   MATCH (survivor:Person {id: $canonical})
   MATCH (dup:Person {id: $dupId})
   CALL {
     WITH survivor, dup
     MATCH (dup)-[r:INTERACTED]-(other)
     CALL { WITH r, survivor, other
       MERGE (survivor)-[:INTERACTED {channel: r.channel, timestamp: r.timestamp, summary: r.summary}]-(other)
     }
     DELETE r
   } IN TRANSACTIONS OF 100 ROWS
   // Same for KNOWS
   DETACH DELETE dup
   ```

6. Log every merge decision to `merge_audit` table (Supabase or Neo4j property) for review + rollback.

### Where it runs
**Agent-side.** New plugin tool `orbit_resolve_identities` that Wazowski runs once after bootstrap (or on-demand). Uses local OpenClaw model via `chatCompletions` endpoint. User's OpenRouter/Anthropic key pays.

### Files
- NEW `packages/orbit-plugin/lib/identity-resolver.js` — orchestrates stages A + B
- NEW `packages/orbit-plugin/lib/identity-resolver-rules.js` — port of Python `CanonicalNameResolver`
- MODIFY `packages/orbit-plugin/lib/llm-categorizer.js` — add `resolveCluster(contacts)` method
- NEW `src/app/api/v1/merge/route.ts` — server endpoint to apply merges
- MODIFY `packages/orbit-plugin/index.js` — add `orbit_resolve_identities` tool + auto-run post-bootstrap

### Cost estimate
For Sanchay's 1,003 persons:
- Stage A: deterministic merges, ~50 auto-merges expected → ~950 persons
- Stage B: ~150 candidate clusters from fuzzy grouping → 8 LLM batches × 4k tokens → ~$0.10 on Sonnet, $0.50 on Opus

---

## Phase 2 — Fix Critical Remaining (after Canonical done)

### P2a — Self-dedup
Merge `p_8a9fbefc` and `p_032f60cf` into `user_728032c5`. Add safeguard in `batchResolveParticipants` that matches participant names against self-user profile + auth email before creating a new Person.

### P2b — Category fix via LLM
Wire up existing `LlmCategorizer` to run after bootstrap on contacts with category === "other". Single prompt per 20 contacts, returns structured `{id, category, confidence}`. Auto-apply with confidence ≥ 0.7.

### P2c — Score redesign
Current problem: 93% cluster at score < 2. Fix the weights:
- **Heavy reciprocal boost.** If person has sent AND received messages with you, 2x multiplier. If only received (broadcast, newsletter-adjacent), 0.5x.
- **Calendar meetings = strong signal.** Each unique meeting = at least 3 points (not 1.5). 5+ meetings over 90 days = max.
- **Group-only presence = de-prioritize.** Currently whatsapp_group = 0.3, but even this produces ~20 group messages = 6 points. Floor it: group-only contacts cap at score 3.
- **Cross-source multiplier.** If someone appears in 2+ channels, 1.5x multiplier.

### P2d — Activate `activeFilter` in dashboard
One-line fix. Pass `activeFilter` from Dashboard.tsx → GraphCanvas. Filter happens in `useGraphData`.

---

## Phase 3 — Plumbing (quick wins)

### P3a — Timezone-aware going-cold digest
Store `profiles.timezone` in Supabase. Convert wall-clock to user-local in the worker.

### P3b — Gmail bootstrap pagination
Override `bootstrap()` in gmail connector to loop through `pageToken` until exhausted (cap at ~5000 messages).

### P3c — Surface config in onboarding UI
Add "Primary delivery channel" and "Timezone" inputs to `/onboarding` page. Save to profile. Plugin reads from `/api/profile` at startup.

### P3d — Fix PATCH to allow clearing fields
1-line change. Use `body.hasOwnProperty('company')` instead of truthy check.

### P3e — Remove hardcoded self names
Calendar + Gmail connectors should fetch user info from `/api/v1/profile` on startup, not have hardcoded arrays.

### P3f — Real JSON5 parser in capabilities
```bash
npm install json5
```
Replace the regex stripper with `JSON5.parse(raw)`.

### P3g — Supabase service role key + capability persistence
Set up service role key in Vercel env vars. Create `agent_capabilities` table with RLS. Replace in-memory Map.

### P3h — Linear connector: double-check auth header
Currently sending `Authorization: <token>` without `Bearer`. Signals ARE flowing (48 last run), so Linear personal tokens might accept this format. But make it explicit.

---

## Phase 4 — UX additions

### P4a — `/person/[id]` page
Standalone URL for a contact. Reuses same person card UI.

### P4b — DELETE /api/v1/persons/:id
Let users remove a node.

### P4c — POST /api/v1/persons/merge — manual merge
For cases where the LLM auto-merge misses or the user sees dupes.

### P4d — Going-cold UI panel
Sidebar widget showing 3-5 contacts going cold this week with "draft a check-in" button.

### P4e — Network-search box on dashboard
Expose `/api/v1/search` as a searchable input in the dashboard header. "Who do I know at X?" returns list + intro paths.

---

## Phase 5 — Operational

### P5a — Vercel cron for daily score-decay job
Daily: apply `score * 0.98^(days_since_last-7)`, floor 0.5, grace 7 days. Requires Vercel Pro ($20/mo) or a plugin-side worker.

### P5b — Audit log table
Every `batchUpsertPersons` write goes to `ingest_audit` with user_id, source (plugin name), signal_count, timestamp.

### P5c — Health endpoint
`GET /api/v1/health` → `{ ok, neo4j_ok, supabase_ok, recent_ingest_count }`.

### P5d — Auto-deploy on GitHub push
Wire up Vercel → GitHub integration. Right now every push needs manual `vercel --prod`.

---

## Suggested session breakdown

- **Session 1 (this one spawning next):** Canonical Identity Resolver + self-dedup (P1 + P2a). End state: ~650 unique persons, no more "Eric x3" / "Ramon x3".
- **Session 2:** Category fix via LLM + score redesign (P2b + P2c). End state: categorization meaningful, score distribution pyramid-shaped.
- **Session 3:** Onboarding UX + timezone + delivery channel + /person/[id] page (P3c + P4a + P3a). End state: a real founder could actually use this daily.
- **Session 4:** Merge/delete UX, going-cold panel, network search UI (P4b-e). End state: the web app earns its existence.
- **Session 5:** Operational — audit log, decay cron, auto-deploy, health endpoint (P5*). End state: production-grade.

## Don't-do list (yet)

- ClawHub submission — GitHub marketplace is fine for now.
- Multi-user / team graphs — single-user is the focus.
- Stripe billing, free/pro tiers — not until we have 3+ real users.
- The rules-as-evidence redesign from `BRAINSTORM-intelligence-redesign.md` — big architectural shift, defer until canonical resolver lands.
