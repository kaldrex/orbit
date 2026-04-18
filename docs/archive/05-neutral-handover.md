# Orbit — Neutral handover

This document is a factual snapshot for someone picking up the project cold. It is intentionally not a plan. It describes what Orbit is meant to do, what exists today, what was touched recently and why (as best the prior author understood), and the open questions that still need a decision. Read it, form your own opinions, disagree where you think the prior choices were wrong.

---

## 1. The problem Orbit is trying to solve

The user wants a system that watches their real communication channels (Gmail, WhatsApp, Google Calendar, Slack, Linear, etc.) and maintains a living knowledge graph of the people in their life — who they talk to, how often, about what, with what relationship temperature. The graph is meant to:

- Continuously ingest signals from every channel the user connects.
- Recognize the same person across channels even when the source systems identify them differently (a JID, an email, a display name).
- Categorize contacts (investor, team, friend, founder, press, family, …) and score relationship strength.
- Enrich contacts with publicly available context (title, company, LinkedIn) so the graph carries more than what the user explicitly typed.
- Extract topics, action items, and sentiment from the actual content of messages so the system knows what a relationship is *about*, not just that it exists.
- Serve all of that back to the user through two surfaces: a web dashboard (reagraph visualization) and an agent tool suite that other LLM apps (notably OpenClaw) can call — `orbit_lookup`, `orbit_person_card`, `orbit_going_cold`, etc.

The long-term outcome the user has described is that every morning the graph is richer than the night before without them doing anything, and that an agent can answer questions like "who should I reconnect with this week, given what I've been working on" or "who in my network just changed jobs" with a real, grounded answer.

There are two non-negotiables the user has repeated:

1. **Universal.** This is going to ship to other humans running their own OpenClaw instances. Nothing should be hardcoded to any one user's specific contacts, names, IDs, or email addresses.
2. **OpenClaw-native.** The plugin runs inside OpenClaw on the user's machine. LLM access is through the local OpenClaw gateway on port 18789 (an OpenAI-compatible `/v1/chat/completions` endpoint). No direct Anthropic/OpenAI SDK calls in the connector/plugin code path.

---

## 2. System shape

### Server
`src/app/api/*` — Next.js App Router routes, deployed to Vercel. The `/api/v1/*` surface is the public agent API (authenticated with `orb_live_*` keys; see [02-live-state.md](02-live-state.md)). Routes of interest:

- `POST /api/init` — creates a user's canonical self node in Neo4j on first dashboard visit.
- `POST /api/v1/ingest` — batch upsert of Person nodes + INTERACTED + KNOWS edges.
- `GET /api/v1/persons` — list; supports `include_self`, `order=id`, `cursor` for batch consumers.
- `PATCH /api/v1/persons/[id]` — update metadata.
- `POST /api/v1/merge` — fold N Person nodes into a canonical; audit-logged in Supabase.
- `GET /api/v1/graph` — dashboard payload.

### Storage
- **Neo4j Aura** for the graph (persons, INTERACTED, KNOWS). Multi-tenant isolation via `userId` property.
- **Supabase Postgres** for auth, profiles, API keys, and `merge_audit`.
- No object store, no warm lossless cache of raw message bodies (yet — this is noted as an open problem).

### Plugin (client-side)
`packages/orbit-plugin/` is an OpenClaw plugin. It runs on the user's own machine (or on a VM they control, like the Wazowski GCE box in the reference deployment). It exposes:

- **Connectors** (`packages/orbit-plugin/connectors/`): Gmail, WhatsApp, Calendar, Slack, Linear. Each one reads from its source (CLI tools like `gws` and `wacli`, local storage files, or webhooks) and emits normalized signals.
- **SignalBuffer** aggregates signals, deduplicates, and POSTs batches to `/api/v1/ingest`.
- **Tools** registered via `api.registerTool(...)` — the agent surface. Currently: `orbit_lookup`, `orbit_person_card`, `orbit_going_cold`, `orbit_graph_stats`, `orbit_status`, `orbit_ingest`, `orbit_log_interaction`, `orbit_network_search`, `orbit_resolve_identities`.
- **Background workers**: `PreMeetingBrief` (every 5 min, sends a context card to the user before meetings) and `GoingColdDigest` (Monday morning, surfaces contacts that have gone quiet).

### Dashboard
`src/components/Dashboard.tsx` + `src/components/graph/*`. Visualizes the graph with reagraph (3D layout). Has category filter pills.

---

## 3. What is broken / not implemented

At the time of this handover, the live graph has ~1,200 persons and tens of thousands of edges, but the data quality is not good enough for the product to deliver on the vision. Specific problems that are measurable today:

- **Duplicate persons.** A single real person is often split across multiple Person nodes — one for the Gmail sender name, one for the WhatsApp display name, one for the calendar attendee. Shared identifiers exist but aren't always used for matching.
- **Wrong-attribution clusters.** Multiple real-but-distinct people sometimes end up attached to the same email (e.g. a generic `eric@company.co` attributed to several different Erics in group threads). Rules cannot tell which is the real owner.
- **93% of persons are uncategorized.** The `category` field defaults to `"other"` and there is no batch job that fills it in. A categorizer (`packages/orbit-plugin/lib/llm-categorizer.js`) exists but is not wired into any cron or post-bootstrap hook.
- **Relationship scores are compressed.** The score increments by `+0.1` per interaction with a ceiling of 10, no decay, no channel weighting. Result: a large fraction of persons sit in a narrow 1–3 band and scores are uninformative.
- **No topic/sentiment extraction.** Interaction edges carry `summary` when a connector populates it, but the optional `topic_summary` / `sentiment` / `relationship_context` fields are never filled. The ingest pipeline throws away message bodies — only metadata (sender, subject, short truncated text) persists.
- **No enrichment.** The graph never reaches out to the public web to learn a title, company, or LinkedIn URL for a new person.
- **No user-correction surface.** If the user can see a bad merge or miscategorization in the dashboard, there is no button to correct it.
- **Agent surface is thin.** The agent can do lookups and list contacts going cold, but cannot answer compound questions ("who in my network works in X who I haven't talked to in Y days"), cannot execute read-only Cypher, and has no daily journal or narrative output.

See [03-problems.md](03-problems.md) for a fuller catalog from earlier analysis.

---

## 4. What the prior session actually changed, and why

The prior agent worked for one long session and committed the following, in order. These are facts about the repo state. Whether the approach was right is a judgment you can form yourself.

### Phase 0 — Verification harness
`scripts/verify-graph.js` computes nine metrics (`M1..M9`) against the live Neo4j graph and prints a scorecard. `scripts/fixtures/bleed-test-signals.json` encodes specific failure cases. `scripts/replay-bleed.js` exercises them against an isolated `__replay_user__` userId and cleans up after itself.

*Stated reason:* can't know if changes help without a measurement loop. Snapshots go to `.verify-runs/` so progress is observable over time.

*Things to challenge:* the specific metric definitions are a judgment call. `M3` in particular was redefined midway through the session from "first-name collisions" to "email-shared clusters with heterogeneous last names". The thresholds are the prior author's opinion. Your metric set may be different.

### Phase 1 — Ingest-side bleed stop
`src/lib/neo4j.ts` — `batchResolveParticipants` was rewritten from name-only matching to a 4-tier cascade:
1. email match,
2. phone match,
3. self-alias match (route the user's own references to their canonical self node),
4. name match,
5. create new.

The new Cypher lives in a shared file `src/lib/cypher/resolve-participants.js` so the bleed-replay test exercises the exact same query the server runs. A new helper `src/lib/self-identity.ts` builds the self-identity signature from the Neo4j self node + the authenticated user's email at ingest time. Connectors were updated to emit `contactEmail` (Gmail, Calendar) or `contactPhone` (WhatsApp) alongside `contactName`. The ingest route's participant collection now dedups by "strongest identifier" (email > phone > lowercased name) before sending to the resolver.

*Stated reason:* before this change, every incoming signal was a source of new duplicates. Nothing downstream could catch up.

*Things to challenge:* (a) the match cascade order is a design choice — arguably phone should come before email since phones are rarely mis-attributed; (b) the dedup key priority is also arguable; (c) opportunistic email/phone backfill (if a matched Person had `null`, fill from the incoming signal) is enabled by default, which is aggressive.

### Phase 2 — Self-dedup, universalized
Originally there was a hardcoded one-shot migration (`scripts/migrations/001-self-dedup.js`) targeting two specific ghost self-node IDs in Sanchay's graph. On push-back from the user ("this is going to other humans, don't cherry-pick") the migration was deleted and the same job was absorbed into the universal identity resolver: any cluster that contains a `category: "self"` entry forces self as the canonical and auto-merges regardless of ambiguity checks. The Neo4j self node now carries an `aliases` array derived universally at `/api/init` time from `display_name` + `auth.users.email`.

*Stated reason:* a per-user migration can't ship to other deployments. Self-dedup has to be an emergent behavior of the resolver.

*Things to challenge:* the alias-derivation function in `src/app/api/init/route.ts` produces a reasonable default list ("Sanchay", "Sanchay T", "Sanchay Thalnerkar", …) — but the user's legal name ("Sanchay Sachin Thalnerkar") doesn't fit that template and had to be appended manually in one case. A user-settable alias list (via the settings page) would remove that gap.

### Phase 3 Stage A — Identity resolver
Two new plugin modules:

- `packages/orbit-plugin/lib/identity-resolver-rules.js` ports `CanonicalNameResolver` from [docs/data-science/intelligence_layer.py](../data-science/intelligence_layer.py) into JS. It clusters persons by shared email/phone and by a set of pairwise name-bridge rules (first+last match with middle-name optional, leading-char strip, uniqueness-gated single-word → full-name, uniqueness-gated last-initial → full-last-name).
- `packages/orbit-plugin/lib/identity-resolver.js` orchestrates: fetches all persons through the HTTP API, runs the rules engine, separates clusters into `certain` (auto-applyable) and `ambiguous` (multiple distinct full surnames on one email, or first names not prefix-related — defer to a Stage B LLM pass or to user review).

Two new server pieces:

- `src/app/api/v1/merge/route.ts` — accepts `{canonical_id, merge_ids[], reasoning, confidence, source: auto|llm|user, evidence?}`. Re-points INTERACTED edges (with dedup on channel+timestamp), re-points KNOWS edges (drops self-loops), unions metadata onto canonical, DETACH-DELETEs merged nodes, inserts an audit row.
- Supabase `public.merge_audit` + `record_merge_audit` RPC (SECURITY DEFINER, callable over anon key — no service role required). The RPC exists because the server authenticates API-key callers and has no JWT, so the naive RLS `auth.uid() = user_id` insert policy fails silently. The first 96 merges the prior agent applied did not reach the audit table for this reason; subsequent merges (after the RPC landed) are recorded.

A plugin tool `orbit_resolve_identities({stage, dry_run, stage_b_preview, max_clusters})` wires this into the agent surface.

*Stated reason:* rules are cheap; LLMs are needed only for the genuinely ambiguous. A two-stage design keeps cost low and lets the LLM focus on hard cases.

*Things to challenge:* (a) this split assumes you believe rules + LLM is the right architecture — you may prefer LLM-end-to-end with rules only as preprocessing, or end-to-end rules with LLM only for review. (b) The ambiguity classifier (multiple distinct surnames, or non-prefix-related first names) is a specific heuristic; another reasonable heuristic is "any cluster larger than 3 on shared email alone is ambiguous". (c) The "uniqueness gate" (single-word → full name only fires when the first name has exactly one full-name signature in the graph) is a defensive choice; in a large graph where Shubham has 12 full-name variants, no single-name "Shubham" ever merges by rule — which may be correct or may be leaving money on the table.

### Stage B (LLM) — designed, not exercised
The orchestrator has a Stage B path that builds candidate clusters (same first name, not already in a Stage A cluster, bucket size ≤ 12 to avoid large common-first-name buckets), sends batches of ~20 to the local OpenClaw gateway, and applies merges with confidence ≥ 0.8. It has never been run — the gateway URL + token have not been configured in the local environment, and the first batch was explicitly meant to be user-reviewed before auto-apply.

### Plugin deployment
`packages/orbit-plugin/` was rsynced to `claw:~/.openclaw/plugins/orbit-connector/` and `systemctl --user restart openclaw-gateway.service` was run. From that point forward, new WhatsApp/Gmail/Calendar signals flow with `contactEmail`/`contactPhone` populated and hit the new matching cascade.

### Current scorecard (from the last verify run)

```
M1  Email-duplicate clusters                   13  (target 0)
M2  Ghost self-nodes                            0  ✓
M3  Wrong-attribution clusters                  7  (target 0, floor ≤2)
M4  % persons categorized (non-other)         6.8% (target 80%)
M5  Max score-bucket share                     44% ✓
M6  % emailed persons with title               31%
M7  % bodied interactions with topics        76.6% ~
M8  Bleed rate (replay test)                    0  ✓
M9  Agent use cases answerable               2/10
```

149 merge clusters have been applied live (96 loose-rule + 53 conservative-rule). The `merge_audit` table has 53 rows; the earlier 96 are visible only as their effects (deleted Person nodes, grown `aliases[]` on canonicals).

---

## 5. Unresolved design questions

You don't have to accept any of the prior author's framing. These are the real open points.

1. **Should the architecture even be "rules first, LLM for the hard cases"?** An equally valid design: send every batch of candidate clusters to an LLM with the rule output as context ("the rules think these should merge, confidence 1.0; here are the raw facts, confirm or reject"). Cheaper rule-first is what was built; more-context LLM may be more accurate.
2. **What happens to the 13 ambiguous clusters that are already in the graph?** Stage B was designed but not run. Alternatives include (a) running it as-is, (b) building a user-correction UI first and letting the user resolve these by hand, (c) leaving them as-is because they're visually distinct and the dashboard shows the wrong-attribution email cases truthfully.
3. **Is the `merge_audit` schema enough for user corrections?** It has a `reverted_at` column but no mechanism to undo a merge (re-splitting a merged node requires the original edges, which were re-pointed or deleted). You may need an event-sourced audit instead of a pointer-in-time audit if revert is a real requirement.
4. **How should low-signal persons be handled?** Many Person nodes come from WhatsApp group participants where all we have is a display name and a group JID. No email, no phone, one or two interactions. These are the main source of noise in the graph and the main source of ambiguity in identity resolution. Options include (a) keep them, accept the noise, let the user correct; (b) filter them out at ingest time below some threshold; (c) park them in a separate "candidates" node label and only promote to Person when stronger signal arrives.
5. **Should ingest capture full bodies?** Currently it doesn't. Phase 5 (not yet built) was slated to add a `raw_interactions` Supabase table and backfill Gmail bodies. Without bodies there is no topic extraction, no sentiment, no enrichment that depends on content. But backfilling years of Gmail takes hours of API time and adds hundreds of MB to Supabase.
6. **Is the `+0.1` scoring function worth keeping?** It produces compressed distributions. Either a smarter score (channel-weighted, decay-aware) or a completely different signal (e.g. "did you reply within 24h") may work better.
7. **What is the right user-correction surface?** The vision doc suggests a merge/split/override drawer in the dashboard with the guarantee that user overrides are sovereign — no future LLM pass may undo them. This hasn't been built.
8. **Where does the enrichment agent live?** Prior plan was `agent-browser` invoked server-side or via the plugin. It's unbuilt. Anthropic API key is available on the reference Wazowski deployment; local gateway is the OpenClaw-native path.

---

## 6. Where the live code and creds are

- Repo: `github.com/kaldrex/orbit`, branch `main`, auto-deploys to Vercel on push.
- Production URL: `https://orbit-mu-roan.vercel.app`.
- Reference plugin deployment: Wazowski (`ssh claw`), plugin at `~/.openclaw/plugins/orbit-connector/`, systemd unit `openclaw-gateway.service`.
- Neo4j Aura credentials + Supabase project IDs + API keys: [docs/handoff/02-live-state.md](02-live-state.md).
- Prior analysis: [docs/handoff/03-problems.md](03-problems.md), [docs/handoff/04-next-steps.md](04-next-steps.md).
- Vision essay written during the session: [docs/vision/01-hybrid-intelligence.md](../vision/01-hybrid-intelligence.md).
- Working plan the prior agent followed: `/Users/sanchay/.claude/plans/yes-but-you-need-proud-parnas.md` (local to the prior session's machine, not committed to the repo). Not binding on you.
- Prior agent's memory notes: `/Users/sanchay/.claude/projects/-Users-sanchay-Documents-projects-personal-orbit--claude-worktrees-xenodochial-vaughan-2a008a/memory/`.

---

## 7. Constraints the user has stated explicitly

These are things the user has said out loud. Treat them as ground truth unless you have a strong reason to push back.

- Must work for **any** user who installs Orbit + OpenClaw. No Sanchay-only hardcoding.
- Must stay **OpenClaw-native**: LLM access through the local gateway, not direct Anthropic.
- Must be **safe about destructive actions**: dry-run by default, audit trail, reversible where possible.
- User wants the agent to **run the loop** (code → test → ship → verify) with minimal interruption, asking permission only for destructive production actions (merge applies, migrations, large LLM spend).
- User wants the system to **keep working until the scorecard meets target**, not declare victory when the floor is met.

---

## 8. Practical first steps when you sit down

These are low-risk orientation moves, not a plan.

1. `npm run verify` against the live graph — see the current scorecard yourself.
2. `ORBIT_API_KEY=… node scripts/run-resolver.js` (dry-run) — look at what the identity resolver sees today and whether you agree with the certain/ambiguous split.
3. Read the three vision/handoff docs: `docs/handoff/03-problems.md`, `docs/vision/01-hybrid-intelligence.md`, this file. Ignore anything you disagree with.
4. Pull the latest `merge_audit` rows (`select ... from public.merge_audit order by applied_at desc`) to see what the resolver has done recently; spot-check a couple of the canonical Person nodes.
5. Decide for yourself what the next change should be. There is no obligation to continue down the prior agent's phase plan.
