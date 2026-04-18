# 08 — Senior Engineer Dump (2026-04-17)

## What this is

This is a zero-context dump for a senior engineer joining the Orbit workstream cold.

It explains:

- what Orbit is supposed to be
- how it relates to OpenClaw
- what we investigated
- what we changed
- what we observed from the live system
- what currently works vs what is still wrong
- what outputs/artifacts exist on disk right now

This document is meant to be read standalone.

---

## Product model

The intended system split is:

- **OpenClaw** = runtime connected to the human's real channels and tools
- **Orbit plugin** = bridge from OpenClaw-connected source data into Orbit
- **Orbit** = canonical relationship/context system that humans and agents both use

The current product intent is **not** "Orbit is another agent runtime."

The current product intent is:

- OpenClaw connects to WhatsApp, Gmail, Calendar, Slack, etc.
- Orbit turns the resulting source data into reusable relationship context
- humans use Orbit directly
- agents use Orbit as the relationship/context layer
- OpenClaw gets smarter because the Orbit plugin gives it better context when needed

Current vision emphasis:

- Orbit should stay mostly non-LLM / non-agent-runtime on the product side
- Orbit should shape the data and the interfaces
- the user's OpenClaw does the active runtime/agent work

---

## Current architecture

### Repo / deployment

- Main repo checkout:
  `/Users/sanchay/Documents/projects/personal/orbit`
- Production URL:
  `https://orbit-mu-roan.vercel.app`
- Git remote:
  `https://github.com/kaldrex/orbit.git`

### Main components

- `src/`
  Next.js app + API on Vercel
- `packages/orbit-plugin/`
  full OpenClaw-native plugin, id `orbit-connector`
- `packages/openclaw-plugin/`
  older / lighter plugin family, id `orbit-saas`
- `marketplace.json`
  marketplace entry mapping `orbit` to `packages/orbit-plugin`

### Live OpenClaw host

- Host alias:
  `claw`
- Service:
  `openclaw-gateway.service`
- Deployed plugin path:
  `~/.openclaw/plugins/orbit-connector/`

Observed runtime facts on `claw`:

- OpenClaw gateway is active
- Orbit plugin is loaded
- Connectors currently enabled:
  - Calendar
  - Gmail
  - Linear
  - WhatsApp
- Slack connector exists in code but was not available on this host during inspection

### Data stores

- Neo4j Aura = relationship graph
- Supabase = auth / API key validation / audit

---

## Key product/design conclusion

The current work converged on this:

- OpenClaw should be treated as the **acquisition/runtime layer**
- Orbit should be treated as the **canonical truth/context layer**
- The current design problem is the **context/truth layer**, not connector existence

More specifically:

- We are not trying to reinvent source connection/auth inside Orbit
- We are trying to define what OpenClaw should collect and how Orbit should store and serve that as reliable relationship context

The important product insight:

- source-specific extraction should happen first
- source-specific cleanup/compression should happen next
- the LLM, where used, should reason over **person-level context packets**, not isolated platform blobs

---

## What we learned from current-web research

We researched adjacent products and public patterns.

Landscape research pack (worktree path from subagent output):

- `/Users/sanchay/.codex/worktrees/13a5/orbit/docs/research/relationship-intelligence-landscape/README.md`

Companies researched:

- Affinity
- Attio
- Clay
- Dex
- Limitless
- Lindy
- Superhuman

Main takeaway:

- no public product appears to fully solve Orbit's exact intended end-state
- CRM truth layers, enrichment systems, personal memory systems, and agent workflow layers all exist separately
- the consistent pattern is:
  - system of record / truth layer first
  - assistant / workflow layer second

Implication for Orbit:

- Orbit should be the canonical relationship graph + correction layer for an OpenClaw-connected world
- agent workflows should sit on top of that truth layer

---

## Live data exploration and observations

### Workbook artifacts created

1. Live system workbook:
   [orbit-data-review.xlsx](/Users/sanchay/Documents/projects/personal/orbit/outputs/orbit-data-review-20260417-1605/orbit-data-review.xlsx)

2. Source output workbook:
   [orbit-source-output-review.xlsx](/Users/sanchay/Documents/projects/personal/orbit/outputs/orbit-source-output-20260417-1825/orbit-source-output-review.xlsx)

These were created to inspect the actual data rather than reason only from code.

### High-level graph observations

From live checks during the session:

- graph size is real and non-trivial
- WhatsApp dominates interaction volume
- identity/enrichment quality remains weak
- duplicate resolution and semantic quality are still the main bottlenecks

Representative earlier scorecard direction:

- duplicates still present
- unresolved identity clusters still present
- categorization quality low
- agent-answerable use cases still far below desired target

### Current source strength by platform

#### WhatsApp

Strongest source for conversational context.

What changed in understanding:

- raw GOWA storage files alone are weak and messy
- the **better operational path is `wacli`**

Observed `wacli` capabilities on `claw`:

- `wacli chats list`
- `wacli messages list`
- `wacli messages context`
- `wacli messages show`
- `wacli contacts show/search`
- `wacli sync`
- `wacli history backfill`

Important conclusion:

- `wacli` is the preferred WhatsApp backbone
- not `gowa`
- `gowa` should be treated as fallback/raw artifact only

#### Gmail

The major discovery was:

- `gws gmail users messages get format:"full"` provides more than metadata
- we can get:
  - snippet
  - multipart structure
  - text/plain body
  - text/html body

This materially improved the Gmail backbone viability.

#### Calendar

Demoted heavily.

Current conclusion:

- Calendar is useful for:
  - attendee identity hints
  - meeting trigger/prep
- Calendar is not a strong main semantic relationship source

#### Slack

Not available on this host during runtime inspection, so current live usefulness is low for this user/deployment right now.

---

## Source-shape examples we inspected

### WhatsApp (source-side)

We pulled live examples from:

- `wacli chats list --json`
- `wacli messages list --json`

Example shapes observed:

- chat rows include:
  - `JID`
  - `Kind`
  - `Name`
  - `LastMessageTS`

- message rows include:
  - `ChatJID`
  - `ChatName`
  - `MsgID`
  - `SenderJID`
  - `Timestamp`
  - `FromMe`
  - `Text`
  - `DisplayText`

This was enough to conclude that WhatsApp can become a proper first backbone source when restricted to DM-only.

### Gmail (source-side)

We pulled live examples with:

- `gws gmail users messages list`
- `gws gmail users messages get format:"full"`

Example shapes observed:

- `From`
- `To`
- `Subject`
- `Date`
- `snippet`
- `text/plain`
- `text/html`

This confirmed that Gmail has enough raw material for a real bootstrap pipeline.

---

## Major product/engineering observations

### 1. LLM should not think in platform-isolated silos

The refined position is:

- rules/logic should be used for:
  - collection
  - normalization
  - filtering
  - token-efficient compression
- then LLM should reason over **person evidence packets**

Not:

- “summarize WhatsApp”
- “summarize Gmail”
- “summarize Calendar”

But:

- gather source-specific context
- merge it into person-level context
- then let the LLM judge category / relationship / ambiguity

### 2. Gmail export was initially too junk-heavy

Problem observed:

- a naive Gmail export just gave back lots of notifications / newsletter-ish operational mail

Example junk classes explicitly discussed:

- GitHub notifications
- Substack
- support/operational emails

This led to the conclusion:

- first export should still capture all in-scope message rows
- but downstream filtering must distinguish:
  - `drop`
  - `raw_only`
  - `relationship_signal`

### 3. WhatsApp groups are too noisy for current V1

Decision reached during the session:

- exclude WhatsApp groups for now
- only ingest / export 1:1 DMs

This is a deliberate product simplification to reduce identity noise.

---

## Code changes made in this session

### A. Ingestion-layer hardening

Files changed:

- [packages/orbit-plugin/connectors/whatsapp/connector.js](/Users/sanchay/Documents/projects/personal/orbit/packages/orbit-plugin/connectors/whatsapp/connector.js)
- [packages/orbit-plugin/connectors/gmail/connector.js](/Users/sanchay/Documents/projects/personal/orbit/packages/orbit-plugin/connectors/gmail/connector.js)
- [packages/orbit-plugin/connectors/gmail/rules.js](/Users/sanchay/Documents/projects/personal/orbit/packages/orbit-plugin/connectors/gmail/rules.js)

What was changed:

- WhatsApp:
  - groups skipped by default
  - DM-only behavior introduced
  - env override retained if group inclusion is ever needed later

- Gmail:
  - connector switched from metadata-only fetch to `format:"full"`
  - body extraction logic added
  - better automated/system email filtering added
  - human-contact heuristics improved
  - detail now prefers snippet/body over subject-only

### B. Export pipeline implementation

Added:

- [packages/orbit-plugin/lib/export-common.js](/Users/sanchay/Documents/projects/personal/orbit/packages/orbit-plugin/lib/export-common.js)
- [packages/orbit-plugin/scripts/check-backbone.mjs](/Users/sanchay/Documents/projects/personal/orbit/packages/orbit-plugin/scripts/check-backbone.mjs)
- [packages/orbit-plugin/scripts/export-whatsapp-whole.mjs](/Users/sanchay/Documents/projects/personal/orbit/packages/orbit-plugin/scripts/export-whatsapp-whole.mjs)
- [packages/orbit-plugin/scripts/export-gmail-whole.mjs](/Users/sanchay/Documents/projects/personal/orbit/packages/orbit-plugin/scripts/export-gmail-whole.mjs)
- [scripts/export-whole-data-from-claw.mjs](/Users/sanchay/Documents/projects/personal/orbit/scripts/export-whole-data-from-claw.mjs)

Purpose:

- export whole in-scope data from `claw`
- use `wacli` only for WhatsApp
- use `gws` for Gmail
- produce local pullback bundles in `outputs/whole-data/...`

### C. Tests added

Added:

- [packages/orbit-plugin/tests/connector-backbone.test.mjs](/Users/sanchay/Documents/projects/personal/orbit/packages/orbit-plugin/tests/connector-backbone.test.mjs)
- [packages/orbit-plugin/tests/export-common.test.mjs](/Users/sanchay/Documents/projects/personal/orbit/packages/orbit-plugin/tests/export-common.test.mjs)

These were run locally and on `claw`.

Observed result:

- tests passed locally
- tests passed on deployed copy on `claw`

---

## Export-pipeline evolution during the session

This is important because the design changed mid-session.

### First export approach

Initial export shape was too “nice” too early:

- WhatsApp was being compressed too early
- Gmail was being classified too early

This was corrected because the user explicitly wanted:

- get **all the data first**
- then apply filtering/rules
- then derive nicer outputs

### Corrected export model

The current intended model is:

- WhatsApp export:
  - one row per DM message
- Gmail export:
  - one row per Gmail message with full body/snippet
- filtering/rules happen after the export layer

### Operational issue discovered

The first “whole” WhatsApp exporter shape was wrong operationally:

- it blocked on `wacli sync --once --refresh-contacts`
- it did not emit data quickly
- it processed one chat deeply before moving on

The user correctly pushed back that:

- breadth matters first
- deep backfill can happen later/in background

So the export direction shifted to:

- write available data early
- avoid making sync the front gate
- treat backfill as bounded/best-effort

### Async/parallel issue discovered

When we made wrapper execution parallel:

- Gmail and WhatsApp launched together
- but `wacli` store-lock contention surfaced

Current conclusion:

- parallelism is correct at the source level
- but WhatsApp-specific concurrency must respect `wacli`'s single-store behavior

---

## Current live export state

There were multiple runs during this session.

### Early sample/dry runs

Sample bundles created here:

- [2026-04-17T12-19-52-786Z](/Users/sanchay/Documents/projects/personal/orbit/outputs/whole-data/2026-04-17T12-19-52-786Z)
- [2026-04-17T12-33-46-955Z](/Users/sanchay/Documents/projects/personal/orbit/outputs/whole-data/2026-04-17T12-33-46-955Z)
- [2026-04-17T12-34-25-711Z](/Users/sanchay/Documents/projects/personal/orbit/outputs/whole-data/2026-04-17T12-34-25-711Z)

These proved the path, but were intentionally capped/small.

### First full-ish run

- [2026-04-17T12-45-00-whole](/Users/sanchay/Documents/projects/personal/orbit/outputs/whole-data/2026-04-17T12-45-00-whole)

Observed:

- initially looked stuck in `wacli sync`
- later did progress
- exported thousands of WhatsApp rows
- stayed in WhatsApp stage for a while

### Async run

- [2026-04-17T12-58-00-whole](/Users/sanchay/Documents/projects/personal/orbit/outputs/whole-data/2026-04-17T12-58-00-whole)

Observed during the latest check:

- status still `running`
- WhatsApp:
  - `14520` rows exported so far
  - `295` chats saturated so far
- Gmail:
  - `1000+` message rows exported so far

This was the latest meaningful progress snapshot captured in-chat.

---

## Important operational conclusions

### Closing the laptop

The user explicitly asked whether the export survives laptop close/sleep.

Current answer:

- **no, not reliably**

Reason:

- orchestration is driven by local `node` + `ssh` processes on this machine
- if the laptop sleeps/closes, do not assume the orchestration remains healthy

This implies a future improvement:

- move the whole export orchestration to run fully on `claw`
- let the laptop only poll/view progress

### “Whole” does not currently mean perfect completeness

Especially for WhatsApp:

- `wacli history backfill` is best effort
- old history availability depends on device/session state
- saturation means “no older data arrived under current attempts”

So whole currently means:

- whole within the current bounded best-effort export process
- not a formal guarantee of omniscience

---

## Git / repo state

The implementation work from this session was committed and pushed.

Commit created:

- `36ebf15`

Commit message:

- `feat: add whole-data export pipeline`

Pushed to:

- `origin/main`

Output artifacts were **not** pushed.

Repo-tracked code/docs were pushed.

---

## What still needs work

### 1. Make whole-data export operationally sane

Current pain points:

- WhatsApp export still needs a better breadth-first strategy
- `wacli` store-lock behavior needs to be respected
- sync/backfill should not block visible progress

### 2. Make export orchestration remote-first

Current orchestration is laptop-dependent.

Desired:

- whole export job lives on `claw`
- laptop only monitors

### 3. Add proper post-export filtering layer

We now have the “all data first” shape.

Next missing layer:

- decision outputs on top of exported rows:
  - `drop`
  - `raw_only`
  - `relationship_signal`

### 4. Turn source data into person-level context packets

This remains the key downstream design goal:

- source capture first
- person packet second
- relationship/context judgment third

---

## Most important takeaways for a new senior engineer

1. The main product problem is the **truth/context layer**, not connector existence.
2. `wacli` is the right WhatsApp backbone; `gowa` should not be the primary interface.
3. `gws format:"full"` makes Gmail usable as a real context source.
4. WhatsApp groups are intentionally excluded for now.
5. We moved from “nice filtered export” to “all in-scope data first.”
6. The whole-data exporter exists, runs, and has written real output.
7. The exporter still needs operational refinement to be robust and fast.
8. Orbit’s long-term role remains:
   - canonical relationship/context layer for an OpenClaw-connected user world

---

## Suggested immediate next actions

If another engineer picks this up immediately, the highest-value next steps are:

1. Refactor WhatsApp export to:
   - breadth-first on DM chats
   - no blocking front-gate sync
   - bounded backfill after visible progress

2. Move export orchestration fully onto `claw`
   - use local machine only for monitoring

3. Add post-export decision pipeline
   - `drop`
   - `raw_only`
   - `relationship_signal`

4. Build person-context packet assembler on top of exported message-level data
