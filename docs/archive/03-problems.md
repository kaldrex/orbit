# 03 — Known Problems (From 3 Parallel Audits)

Not a vent list. Every entry here is real, reproducible, and came from auditing the live database, the plugin code, or the server code.

---

## 🔥 Critical — breaks the user experience

### C1. Duplicate persons — 10 confirmed clusters
Same email, multiple Person IDs. Agent creates a shortname node (e.g. "Eric" from WhatsApp) then a full-name node from email headers (e.g. "Eric Guo" from Calendar) with **no dedup on email key** before insert.

| Email | Count | Duplicate names |
|---|---|---|
| `as@millionlights.uk` | 4 | Ashish / AS / AS Millionlights / Akshat Shrivastava |
| `eric@anysphere.co` | 3 | Eric Guo / Eric / Eric Bernstein |
| `suhas@localhosthq.com` | 2 | Suhas Sumukh / Suhas |
| `shahidshrivastava.01@gmail.com` | 2 | Ashutosh Shrivastava / Shahid Shrivastava |
| `naviddieumusicien@gmail.com` | 2 | Navid Dieu / Navid |
| `claudecakey@gmail.com` | 2 | Gabe / Gabriel |
| `usheik@sinxsolutions.ai` | 2 | Usheik / Umar Sheik |
| `dj@openblocklabs.com` | 2 | DJ / DJ Oleson |
| `tejpal@openblocklabs.com` | 2 | Tejpal / Tejpal Singh |

Plus `Sanchay Thalnerkar` has two IDs (self `user_728032c5` + ghost `p_032f60cf`).

**Fix:** LLM-powered canonical resolver (see `04-next-steps.md`). Rule-based `CanonicalNameResolver` from data-science branch should be first pass, then LLM for the ambiguous ones.

### C2. Self-pollution — 2 rogue "Sanchay" nodes
- `p_8a9fbefc` ("Sanchay", **272 INTERACTED edges**) — WhatsApp messages where "Sanchay" appeared as a sender label. Every message from Sanchay himself becomes an edge to this ghost.
- `p_032f60cf` ("Sanchay Thalnerkar", 18 edges) — from Gmail From header of own emails.

**Both should be merged into `user_728032c5` and marked `is_self: true`.** Currently double-counts self-interactions.

**Fix:** Add "is this the self-user?" check in `batchResolveParticipants` using (a) email match against Supabase auth.email, and (b) name match against profile.display_name.

### C3. Categorization is broken — 90.6% "other"
At 1,003 nodes, 909 are in the catch-all "other" bucket. The category field has near-zero signal for filtering, UI grouping, or any decision.

**Fix:** The `LlmCategorizer` module exists at `packages/orbit-plugin/lib/llm-categorizer.js` but is **never instantiated**. Wire it up to run after bootstrap on contacts with category === "other".

### C4. Scoring is flat — 93% at score < 2
| Bucket | Count |
|---|---|
| < 1.5 | 487 (48.7%) |
| 1.5–2 | 446 (44.6%) |
| 2–5 | 44 (4.4%) |
| ≥ 5 | 23 (2.3%) |

A scoring model where 93% of contacts cluster at the floor is useless for ranking.

Root cause: WhatsApp group messages use channel `whatsapp_group` which gets signal weight 0.3 — so a contact who's in 20 of your groups still scores ~2.0 total. Real DM contacts score similarly because the first real DM weight is 1.2. Not enough dynamic range.

**Fix:** Re-weight signals. Give large boost for reciprocal calendar meetings + reciprocal DMs. Penalize group-only presence more. See scoring redesign in `04-next-steps.md`.

### C5. Cross-source merge gap — only 5% of contacts are multi-sourced
- WhatsApp-only: 858 (85.7%)
- Calendar/meeting-only: 74 (7.4%)
- Multi-channel: 51 (5.1%)

Ashutosh in Calendar + Ashutosh in WhatsApp = 2 nodes. Same for everyone.

**Fix:** Cross-source identity linker (part of canonical resolver). Match on email-domain-to-phone patterns, first-name + last-initial, or explicitly via user-provided "this is me" mapping.

---

## 🟠 High — breaks features

### H1. `activeFilter` is never passed to GraphCanvas
In `src/components/Dashboard.tsx`, `activeFilter` state is set by clicking the filter chips ("Investors", "Going Cold", etc.) but **never passed as a prop to `GraphCanvas`**. The filter pills are cosmetic — clicking "Going Cold" does nothing.

**Fix:** 1-line — pass `activeFilter` as prop, filter nodes in `useGraphData`.

### H2. Dashboard uses `/api/graph`, not `/api/v1/graph` — inconsistent API
There are **two** graph endpoints: `/api/graph` (legacy, session-auth, returns full nodes+links for dashboard) and `/api/v1/graph` (agent-auth, returns stats only). The dashboard uses the legacy one exclusively. Nothing documents this.

**Fix:** Merge into one `/api/v1/graph` that returns nodes+links+stats, support both session and API key auth. Dashboard should use `/api/v1/*`.

### H3. No `/person/[id]` page — person panel only lives in sidebar
Clicking a node opens `PersonPanel` as a sidebar. There's no standalone URL for a contact. You can't send someone "here's the link to your own node."

**Fix:** Add `src/app/person/[id]/page.tsx` that renders the same content as a full page.

### H4. `PATCH /api/v1/persons/:id` can't clear a field
`if (body.company)` truthy-check silently ignores `{ "company": "" }`. No way to null out a field.

**Fix:** Distinguish `undefined` (don't change) from `null` or `""` (clear).

### H5. No DELETE or MERGE endpoint
`DELETE /api/v1/persons/:id` doesn't exist. Nuclear `/api/v1/reset` is the only way to remove data. No way to merge two nodes from the UI.

**Fix:** Add both endpoints.

### H6. `LlmCategorizer` is defined but never called — dead code
`packages/orbit-plugin/lib/llm-categorizer.js` implements agent-side LLM categorization with batch prompts. It's exported. Nothing imports it.

**Fix:** Wire into connector registry's post-bootstrap hook.

### H7. Gmail bootstrap only gets last 100 messages — not full history
`BaseConnector.bootstrap()` default delegates to `poll(new Date(0))`. Gmail's `after:` filter on epoch 0 fetches the 100 most recent messages, not all history. There's no pagination.

**Fix:** Override `bootstrap()` in gmail connector to paginate with `pageToken`.

### H8. Pre-meeting brief worker runs with no delivery target
Fires every 5 min. Without `ORBIT_DELIVER_TO` env var (no UI to set it), just logs to stdout. Silent "it's working" illusion — user never sees a brief.

**Fix:** (a) Surface config in `/onboarding` page. (b) Auto-detect primary channel from capability report (if only WhatsApp is wired, use that).

### H9. Going-cold digest uses VM timezone, not user's
`new Date().getHours() === 8` runs in the VM's TZ (UTC on GCP). User is in India. Digest fires at 01:30 local instead of 08:00.

**Fix:** Store user's timezone in profile, convert at cron-check time.

### H10. Linear connector sent raw token, not `Bearer ` prefix
`Authorization: token` (line 62) — Linear requires `Bearer <token>`. Every call returned 401, silently caught, zero signals. **Actually wait — we saw 48 signals came in, so this might already work (Linear accepts raw for personal tokens).** But double-check.

---

## 🟡 Medium — silent failures / data quality

### M1. 858 WhatsApp-only contacts mostly low-signal noise
Most have score < 1.5. Many are likely group-chat co-members, one-off message threads, service senders. The ingestion has no "is this worth tracking" threshold.

**Fix:** Introduce a minimum-quality threshold per-contact (e.g. require ≥5 real-day interactions OR explicit DM OR cross-source evidence to retain).

### M2. Non-human nodes still slip through
Found in current data:
- `Royal enfield manager service center` (score 4.6!)
- `Cursor Mumbai, India` — event
- `Indie Hackers` — community/newsletter
- `Finn at Aqua` — product name in email subject

**Fix:** Expand `ingest-filters.isJunkParticipant` with keyword heuristics ("manager", "service", "center", "India", ", " comma patterns).

### M3. JSON5 "parser" in `capabilities.js` is three regexes
Breaks on: `systemPrompt` with `//` inside strings, quoted URLs with `/*`, backslash-escaped sequences, any complex openclaw.json. Current symptom: telegram and slack channels show `false` even when configured.

**Fix:** Use actual JSON5 parser (`json5` npm package) or switch approach — read channel config directly from OpenClaw's HTTP API instead of parsing the file.

### M4. Rate-limit is in-memory per serverless instance
`api-auth.ts` has an in-memory `failedAttempts` Map that resets on cold start. Brute-force protection effectively disabled under distributed load.

**Fix:** Upstash Redis or Supabase for shared rate-limit counters.

### M5. Capability store resets on cold start
`/api/v1/capabilities` uses a module-level Map. Onboarding UI shows "Waiting for connection…" after any cold start until plugin re-reports.

**Fix:** Persist to Supabase `agent_capabilities` table (need service role key).

### M6. Scoring recomputed on every page load
`/api/graph` recomputes scores from raw edges per request. N+1 pattern on Neo4j. Fine for 1,000 nodes, won't scale.

**Fix:** Cache scores with TTL, or materialize into Person node property via periodic job.

### M7. Hardcoded self names in connectors
`calendar/connector.js` has `SELF_NAMES = ["sanchay", "sanchay thalnerkar"]`. `gmail/connector.js` has `SELF_EMAILS` with 3 personal addresses. This file is distributed via the marketplace — any other user gets wrong behavior.

**Fix:** Derive from `profiles.display_name` + `auth.users.email`, fetched once at plugin startup.

### M8. Bootstrap race — parallel state writes
`startBatchPolls` fires all bootstrap coroutines fire-and-forget. They all mutate the same `state` object; `saveBootstrapState(state)` calls race. Losing a bootstrap marker means that connector re-bootstraps on next restart, creating duplicate signals.

**Fix:** Sequential bootstraps or per-connector state files.

### M9. `signal-buffer._seen` map grows unbounded during bootstrap
28,275 WhatsApp messages → millions of dedup entries in Map before first flush. Memory spike during bootstrap.

**Fix:** LRU eviction or size cap.

### M10. Slack connector has no bootstrap
Realtime-only. No historical Slack message ingestion. Slack DMs from before install are lost.

**Fix:** Add `bootstrap()` that uses Slack's `conversations.history` API.

---

## 🔵 Low — nice-to-have / cleanup

### L1. `Dashboard.tsx` filter UI is dead (see H1 above)
### L2. `/test-graph` page should be removed before real launch
### L3. `going-cold-digest` can fire twice if plugin restarts between 08:00–08:30 Monday (in-memory `_lastFiredDay` not persisted)
### L4. `pre-meeting-brief` not re-entrant guarded — slow API call + next tick = duplicate brief
### L5. No audit log of any ingest activity
### L6. No `/api/v1/health` endpoint
### L7. No Supabase service role key set up — blocks persistence of capability store, among other things
### L8. `_loaded` flag in IdentityCache set before load completes — retry is no-op on failure
### L9. Unused identity fields: `Person.phone` is referenced in GET /api/person/:id but never populated
### L10. `INTERACTED.direction` only set by single-interaction endpoint, not bulk ingest
### L11. `last_interaction_at` mixes datetime-object + epoch-millis types in different places; silent comparison failures possible
### L12. No Vercel auto-deploy from GitHub pushes — manual `vercel --prod --yes` only
### L13. `SELF_EMAILS` in gmail connector doesn't include `sanchaythalnerkar@gmail.com` — only 3 older addresses
### L14. Bootstrap only reads `history-*-RECENT.json` — `INITIAL_BOOTSTRAP.json` files (multi-year history) silently dropped
### L15. `bigbasket`, `Zerodha Broking Ltd` etc. were caught by the latest filter expansion, but there's no per-user "these slipped through, add to denylist" UI

---

## Summary by number

- **Critical:** 5 issues
- **High:** 10 issues
- **Medium:** 10 issues
- **Low:** 15 issues

**40 concrete problems** after one full build cycle. Half of them are cheap wins (1-10 lines of code). The critical ones (canonical identity, scoring, categorization) are the real project.
