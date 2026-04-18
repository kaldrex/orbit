# 06 — OpenClaw + Orbit Universal System Model

## Why this doc exists

This is a working reference for thinking clearly about the system we are
actually building.

It is not a final product spec and not a rigid implementation plan. It is a
shared architecture model for ongoing discussion, with the end goal in mind:

- Any user can run OpenClaw on their own machine or VM
- They connect their own WhatsApp / Gmail / Calendar / Slack / Linear / etc.
- Orbit starts building a usable relationship system with minimal manual setup
- The system works universally, not just for one user's data quirks

This doc combines:

- official OpenClaw docs and repo guidance
- the current Orbit repo structure
- live inspection of the Wazowski deployment
- a proposed universal split of responsibilities

## OpenClaw: what it is

OpenClaw is the local runtime, not the CRM.

Based on the current OpenClaw docs, the important architecture facts are:

- OpenClaw runs a single Gateway process on the user's own machine or server.
- The Gateway is the source of truth for sessions, routing, and channel
  connections.
- Config lives in `~/.openclaw/openclaw.json`.
- Workspace state lives under `~/.openclaw/workspace`.
- Secrets, credentials, auth profiles, sessions, and managed skills live under
  `~/.openclaw/` and are intentionally separate from the workspace.
- Plugins load from OpenClaw's discovered extension paths plus
  `plugins.load.paths`.
- Plugins can contribute tools, hooks, skills, config schema, and plugin-scoped
  env/config.
- OpenClaw is multi-channel and agent-native: it owns the live connection to
  chat surfaces, sessions, tool invocation, and message delivery.

Official references:

- OpenClaw docs index:
  `https://github.com/openclaw/openclaw/blob/main/docs/index.md`
- OpenClaw configuration reference:
  `https://github.com/openclaw/openclaw/blob/main/docs/gateway/configuration-reference.md`
- OpenClaw agent workspace concept:
  `https://github.com/openclaw/openclaw/blob/main/docs/concepts/agent-workspace.md`
- OpenClaw skills/tools docs:
  `https://github.com/openclaw/openclaw/blob/main/docs/tools/skills.md`

## What we observed in the live Wazowski runtime

The current reference deployment confirms the architecture above in practice.

- `openclaw-gateway.service` is running under user systemd.
- The gateway is live on `127.0.0.1:18789`.
- The Orbit plugin is loaded and registering tools.
- The plugin directory on the host includes both `orbit-connector` and an older
  `orbit-saas` plugin family.
- The active plugin path is `orbit-connector`; `orbit-saas` is stale config
  drift that should not define the future system shape.

What matters for system design is this:

- OpenClaw already gives us a durable place to run connectors and agents close
  to the user's accounts.
- The local agent machine is where channel auth and source-specific extraction
  naturally belong.
- Orbit should consume normalized facts from OpenClaw, not try to replace the
  OpenClaw runtime.

## The clean universal split

This is the architecture split I think we should use.

### OpenClaw's job

OpenClaw should be the local runtime and acquisition layer.

It should own:

- channel authentication and connection state
- source-specific connector logic
- local message/session handling
- local agent workflows and channel-native actions
- polling / webhook / event ingestion from user-owned services
- source-specific parsing and normalization
- local buffering / retries / backoff
- optional local delivery flows like pre-meeting messages or digests

OpenClaw should not be the canonical relationship database.

### Orbit plugin's job

The Orbit plugin should be the universal bridge from OpenClaw facts into Orbit.

It should be thin, generic, and boring.

Its responsibilities:

- detect which channels / data sources are available
- extract normalized events from OpenClaw-connected systems
- preserve strong source identifiers whenever available
- attach participant identifiers like email / phone / JID-derived phone
- send raw facts and normalized events to Orbit
- expose Orbit read tools back into OpenClaw

The plugin should not carry user-specific heuristics for identity truth unless
they are source-generic and universally safe.

### Orbit's job

Orbit should be the canonical relationship system.

It should own:

- raw event ledger storage or at least durable raw-event references
- normalized cross-source event model
- canonical people / aliases / companies / interactions
- identity resolution and merge review
- scoring and freshness logic
- semantic enrichment and categorization
- founder-facing search, views, briefs, recommendations, and review surfaces
- auditability and user corrections

That means Orbit is not just "another tool inside OpenClaw". It is the system
that turns local source facts into a portable, queryable, founder-usable
relationship model.

## The core principle: source facts first, derived intelligence second

The current system still jumps too quickly from source signals to derived
`Person` nodes and summary views.

For a universal product, the safer order is:

1. collect raw source facts
2. normalize them into a universal event schema
3. resolve identity
4. derive interactions / people / companies / scores
5. generate founder-facing intelligence

If we skip step 1 or weaken step 2, the system becomes hard to trust and hard
to repair.

## The minimum universal data model

For a new user to "connect stuff and it just works", Orbit needs a stable
cross-source contract.

At minimum, every incoming event should try to preserve:

- `source`
- `source_account_id`
- `source_event_id`
- `channel`
- `occurred_at`
- `ingested_at`
- `direction`
- `thread_or_conversation_id`
- `participants_raw`
- `participant_emails`
- `participant_phones`
- `participant_handles`
- `body_available`
- `body_preview`
- `attachments_present`
- `connector_version`
- `raw_ref` or replay reference

The point is not to expose all of this to the founder.

The point is that Orbit should be able to replay, debug, re-resolve, and
explain its own conclusions without depending on ad hoc per-user cleanup.

## The spreadsheet-like brainstorm layer

This is not the final product layer.

It is the best intermediate thinking and truth layer while the system is still
being designed and hardened.

I think we should deliberately use spreadsheet-like views as the control plane
for understanding what Orbit is receiving and where the universal abstractions
break.

Recommended working views:

### 1. Raw Events

Purpose:

- see what each connector is truly emitting
- confirm source IDs and timestamps
- catch malformed or low-signal events
- make replay/debugging possible

Example columns:

- `source`
- `source_event_id`
- `channel`
- `occurred_at`
- `participants_raw`
- `participant_emails`
- `participant_phones`
- `body_preview`
- `body_available`
- `status`

### 2. Identity Candidates

Purpose:

- inspect duplicate clusters
- decide what evidence is strong enough to auto-merge
- separate safe merges from review-required merges

Example columns:

- `candidate_cluster_id`
- `canonical_person_id`
- `member_person_ids`
- `shared_email`
- `shared_phone`
- `name_variants`
- `confidence`
- `reason`
- `needs_review`

### 3. People

Purpose:

- inspect the actual founder-facing canonical entity set
- validate titles, categories, freshness, and score quality

Example columns:

- `person_id`
- `canonical_name`
- `primary_email`
- `primary_phone`
- `company`
- `title`
- `category`
- `last_true_interaction_at`
- `relationship_score`
- `confidence`

### 4. Interactions

Purpose:

- see the real relationship memory layer
- confirm summaries, topics, and event linkage

Example columns:

- `interaction_id`
- `person_id`
- `channel`
- `occurred_at`
- `summary`
- `topic`
- `source_event_refs`
- `quality_score`

### 5. Review Queue

Purpose:

- create a durable correction surface
- keep user overrides sovereign

Example columns:

- `item_type`
- `target_id`
- `issue`
- `suggested_action`
- `model_confidence`
- `human_decision`
- `resolved_at`

This layer is valuable because it gives us a place to reason about the system
without pretending the graph view or the founder-facing AI layer is already the
best debugging surface.

## How the universal user flow should work

The desired universal experience is:

1. User signs up for Orbit.
2. Orbit gives them an install flow and API key for the plugin.
3. User installs the Orbit plugin into OpenClaw.
4. The plugin inspects the local OpenClaw environment and sees what is already
   connected.
5. The plugin starts collecting normalized events from the available sources.
6. Orbit builds the raw event ledger and canonical relationship model.
7. Founder starts getting useful value without hand-curating the system first.

For that to work universally, the product must handle three classes of sources:

- strong-identity sources
  examples: Gmail sender email, Calendar attendee email
- medium-identity sources
  examples: Slack display name plus workspace identity
- weak-identity sources
  examples: WhatsApp group display names with little else attached

The system should not pretend those are equally trustworthy.

## What "just works" should mean

It should not mean "perfectly merged graph with magical enrichment on day one."

It should mean:

- the plugin installs cleanly
- the plugin discovers available channels
- events begin landing without manual coding
- strong identifiers merge correctly
- weak identifiers are contained instead of poisoning the graph
- the founder can search, inspect, and correct what matters
- the system improves with more data instead of degrading with more data

That last line is the real product bar.

## Proposed product boundary

If we keep the split clean, the system becomes understandable:

- OpenClaw answers:
  - what is connected?
  - what messages/events are happening right now?
  - what local actions can the agent perform?

- Orbit answers:
  - who is this?
  - what relationship do I have with them?
  - what happened across channels?
  - who should I talk to?
  - what should I know before this meeting?

That boundary is good because it lets OpenClaw stay general-purpose while Orbit
becomes a specialized relationship product.

## Practical implications for the current repo

Based on the current codebase, this suggests:

- `packages/orbit-plugin/` should evolve toward a universal normalization and
  delivery layer, not a place for product-specific truth heuristics.
- Orbit server routes should become stricter about event contracts, persistence
  guarantees, and replayability.
- The founder-facing product should be built on top of canonical entities and
  reviewable evidence, not directly on top of connector output.
- The spreadsheet-like control plane should be treated as a design aid and
  truth-debugging surface while the universal model is being stabilized.

## Current working thesis

The correct shape is:

- OpenClaw = runtime + connectors + local agent actions
- Orbit plugin = universal bridge
- Orbit backend = canonical relationship system
- Spreadsheet-like layer = temporary but important design/control plane
- Founder UI = the eventual product layer built on top of trusted canonical
  data

That is the path that gets us closest to the real vision:

"Connect your OpenClaw, and Orbit starts building a useful relationship system
for you without custom engineering."
