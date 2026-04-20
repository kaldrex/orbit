# 10 · EDA Findings — 2026-04-19 session

> **STATUS: historical (2026-04-19 EDA). The findings here seeded the V0 pipeline in [11-v0-pipeline-handoff-2026-04-19.md](./11-v0-pipeline-handoff-2026-04-19.md) and the current clean-DB state in [14-cleanup-2026-04-20.md](./14-cleanup-2026-04-20.md).** Retained as the canonical dataset recon (LID dominance, Umayr dossier, topology seeds).
>
> Handoff from the data-gathering session requested in [09-data-gathering-handoff.md](./09-data-gathering-handoff.md).
> Written when Sanchay cut the session short and re-routed execution to himself / a future session.
> No code shipped. Findings + design decisions + honest notes on what the agent got wrong.

## What was executed on the claw VM this session

- Full VM audit (installed binaries, live data paths, service state, credentials status)
- Forensics on the 2026-04-16 `orbit-experiment/` pipeline (the 1%-cross-source run)
- Profile of the Orbit Postgres `raw_events` table (33,105 rows)
- Deep dossier on one human (Umayr) across wacli + session.db + Gmail NDJSON + Contacts NDJSON
- wacli capture-model investigation (streaming vs backfill, live state)
- Cleanup: disabled two failing orbit crons + archived 41 pre-pivot files (see "VM state after cleanup")

## VM state after cleanup

**Cron jobs** (`~/.openclaw/cron/jobs.json`):

| job | state |
|---|---|
| `daily-briefing` | enabled (healthy) |
| `Memory Dreaming Promotion` | enabled (healthy) |
| `orbit-relationship-sync` | **disabled this session** (was timing out every 4h) |
| `orbit-full-ingest` | **disabled this session** (was running every minute, timing out, 6 consecutive errors, 600s budget) |

**Archived wreckage** at `~/.openclaw/workspace/.archive/pre-pivot-2026-04-19/`:
- 30 × `orbit_*.py` (2026-04-16/17 pipeline attempts, all superseded)
- 11 × `memory/2026-04-*-orbit-ingest*.md` (session logs from those attempts)
- 41 total. `~/.openclaw/workspace/` + `~/.openclaw/workspace/memory/` now have **zero** orbit-ingest residuals. OpenClaw's memory indexer will drop them on next tick.

**Nothing else on the VM was modified.** Ledger, sessions, skills, config, other crons all untouched.

## The data — what we now know that we didn't

### 1. LID dominance is load-bearing

- **58.2% of senders in `raw_events` are `@lid`**, not phone. Any identity waterfall keyed on phone alone loses the majority of WhatsApp traffic at step 1.
- `session.db.whatsmeow_lid_map` has **14,995 LID↔phone pairs** — this table is a hard dependency for resolving group-participant rows (which carry only `@lid`) back to phone identities in `messages`.

### 2. The "1%" was architectural, not a tuning failure

- `orbit-experiment/experiment.py` is a **6-pass greedy string-key merge**. Zero LLM calls in the actual run. The code *generates* prompts and prints them to stdout — never sends them.
- "1% cross-source" = `6/597 identities with len(sources) > 1`. No scored pair candidates. No losers persisted. No confusion matrix.
- Structural cause: calendar is email-keyed, WhatsApp is phone/LID-keyed, Gmail is email-keyed. Only bridge attempted was "fuzzy-match WhatsApp pushname to calendar-extracted name @ 0.75 threshold" — per REPORT.md, only **53/701 DM JIDs had a pushname matching any calendar name at all**. That's the ceiling.

### 3. Cross-source data we need is already on disk

`~/.orbit-export/` on the VM (25 MB total):
- `gmail-wide-20260418.messages.ndjson` (1.5 MB)
- `gmail-wide-20260418.ids.ndjson` (112 KB)
- `google-contacts-20260418.ndjson` (185 KB) — note: single-line JSON despite the `.ndjson` extension
- 7 timestamped packet-snapshot dirs

`gws` is authorized (13 scopes, Gmail modify + Calendar + Contacts.readonly, token cache refreshed 2026-04-19 03:16 UTC). Fresh pulls are cheap.

### 4. Ground-truth identity seeds are NOT 30-50 — they're thousands

- `wacli.db.contacts` = **11,822 rows** (jid, phone, name, push_name, full_name)
- `session.db.whatsmeow_lid_map` = 14,995 LID↔phone pairs
- `google-contacts-20260418.ndjson` = thousands of `(phone, name, occasional email)` tuples

The prior handoff's "30–50 human-provided bridges" number was wrong by 2-3 orders of magnitude. The deterministic bridge layer is already dense.

### 5. Thread concentration is extreme

- 5 threads = 50% of all rows
- 29 threads = 80%
- 1,235 of 2,096 senders (58.9%) have exactly **one** message. Mostly group chatter + bots.
- Real human-interaction count is ~150–300, not 2,096.

### 6. Text signal is polluted by placeholders

- ~19% of `body_preview` rows are attachment placeholders: `(message)`, `Sent image`, `Sent document`, `[Audio]`, `Sent sticker`.
- 80 distinct preview strings repeat >10 times each.
- Any content-based reasoning (LLM bridging, embeddings) must filter these.
- `body_preview` is capped at 160 chars in Orbit's ledger — **full text lives only in `~/.wacli/wacli.db` on the VM**.

### 7. There's a latent bug in `participants_raw` semantics

`raw_events.direction='out'` rows put the *peer's* jid in `participants_raw[0]`, not Sanchay's. Umayr is the #1 "outbound sender" because he's Sanchay's #1 recipient. **Any projection reading `participants_raw[0].jid` as author will mis-attribute 22.9% of rows.** Matters the moment we build a persons table.

### 8. wacli capture model (direct answers)

- **Streaming**: yes, via `wacli sync --follow`. **Nobody runs `--follow` persistently on the VM.** No systemd unit, no pm2 entry, no cron job invokes it. The 33,105 rows came from one-shot `wacli sync` runs on 2026-04-17/18.
- **Backfill**: `wacli history backfill --chat <jid> --requests N --count 50`. Per-chat, anchors on oldest locally-stored message, asks phone to replay, best-effort. Phone must be online. **Not blanket-runnable** — 878 chats × 3 requests ≈ hours of ringing the phone for little return.
- **Two parallel WA stacks on the VM**:
  - `gowa` (pm2 + systemd) → `wa-proxy` → `/hooks/whatsapp` → agent. **gowa logged out 2026-04-09 06:29 UTC** (remote logout truncated its local store to 0/0). Still running, producing nothing.
  - `wacli` (separate whatsmeow session, survived gowa's logout). Writes to `~/.wacli/wacli.db`. Last written 2026-04-17 13:37 UTC. **Currently ~2 days stale.**
- Conclusion: WA persistence is dark until someone runs `wacli sync --follow` or a cron invokes it.

### 9. The Umayr case study (one concrete example)

| record | source | what it contains |
|---|---|---|
| wacli.db.contacts | WA | `{jid: 971586783040@s.whatsapp.net, phone: 971586783040, push_name: Umayr, full_name: Umayr}` + LID twin `207283862659127@lid` |
| session.db.whatsmeow_lid_map | WA | `lid=207283862659127 / pn=971586783040` — bridges LID to phone |
| Google Contacts NDJSON | Contacts | `{displayName: Umayr, phoneNumbers: [{canonicalForm: +971586783040}]}` — **first-name only, no email, no org, no notes** |
| Gmail NDJSON | Gmail | 2 messages (both outbound from Sanchay), To: `Umayr Sheik <usheik@sinxsolutions.ai>`. **Surname "Sheik" and SinX affiliation exist ONLY in Gmail headers.** |
| wacli.db.chats | WA | DM thread with 3,371 messages over 2026-02-06 → 2026-04-12 |
| wacli group_participants | WA | 4 shared groups (SinX, SinX \|\| Hub, Weddingdai 3.0, Jewelry AI) |

**Cross-source bridges observed**:
- WA ↔ Contacts: **mechanical via phone** `+971586783040` (byte-for-byte match)
- WA ↔ Gmail: **no structural link**. Only "Umayr" first-name + content consistency (both talk about SinX / jewelry / tech work). In a corpus with multiple Umayrs this collides.

**The take-away**: phone-keyed bridges to Google Contacts are trivial and high-coverage. Email-keyed bridges (Gmail) require content inference — the 99% case the old heuristic missed.

## Design decisions locked this session (saved to Claude auto-memory)

1. **V0 channel scope**: WhatsApp first (via `wacli.db`), then bridge to Gmail + Google Contacts + Calendar. Apple Contacts / iMessage explicitly deferred post-V0.
2. **Single-source relationships are first-class packet states**, not failures. A WA-only close contact (mother, childhood friend, local physio) gets a complete packet. The old "1% cross-source match rate" partly reflected treating single-source as failure — that's a pipeline bug, not a constraint.
3. **Seed filter = OR across channels**, never AND. Anyone with WA DM ≥ N messages OR in Google Contacts OR Gmail/Calendar recent 180d qualifies.
4. **Rank formula = additive** (`recency + attention + cross_source`), not multiplicative on cross-source (which would penalize WA-only high-value relationships).
5. **Observations carry reasoning chains** (evidence + tools_used + reasoning narrative), not just the fact. Every observation is a verifiable claim with a trail that subsequent passes can validate, strengthen, supersede, or chain off. *No claim without a reasoning entry.*
6. **Resolver architecture**: per-person, agentic (LLM drives), rules-as-tools. LLM reads structured seed input, calls tools, emits observations with reasoning. Not rule-first-LLM-fallback.
7. **Thresholds**: ≥0.9 confidence → auto-accept. 0.6–0.9 → `needs_review: true`. <0.6 → record as `unresolved_candidates`, no bridge written.
8. **Budget**: ~15–20 tool calls per person. Backfill is agent-demanded only (never blanket).

## The architecture that emerged

**OpenClaw is the agent execution surface.** Not a side Python script, not a hosted backend. Every founder brings their own OpenClaw with their own LLM budget, their own channel credentials, their own tools.

- `~/.openclaw/skills/orbit-resolve-identity/SKILL.md` — the resolver as a SKILL.md file (YAML frontmatter + markdown body). Composes over existing skills (`wacli`, `gog`, etc.).
- Agent reads the skill, picks tools, investigates one person (or a batch of seeds), emits observations.
- Observations flow to Orbit via existing `orbit_ingest` MCP tool (already wired into Wazowski — currently connects to an Orbit MCP server which writes to Neo4j).
- Orbit itself: receives observations, assembles packets, exposes the three contracts. No agent logic in Orbit.

## What Wazowski already has that we'll compose over

53 installed skills at `/usr/lib/node_modules/openclaw/skills/`. Most relevant:

- `wacli` — WhatsApp CLI (send, search, sync, backfill)
- `gog` — Google Workspace (Gmail / Calendar / Contacts — same binary as `gws`)
- `slack`, `linear`, `imsg`, `apple-notes` — later channels
- `memory_search`, `memory_get` — agent-facing memory query

Plus the `orbit_ingest` + `orbit_graph_stats` MCP tools already wired in.

## Open questions the next session will have to answer

1. **Exact `orbit_ingest` tool signature.** Need to inspect the MCP server (likely spun from the Orbit repo). Does it accept the full observation shape with reasoning chains? Or is its current contract narrower (just `{people, interactions}` per the old cron prompt)?
2. **Observation API on Orbit.** `POST /api/v1/person/:id/observation` is still unimplemented in the Orbit repo. Does the resolver skill write via `orbit_ingest` MCP, or directly HTTP-POST to Orbit?
3. **Raw events vs observations semantics.** The three-contracts architecture says `raw_events` is the sole write-entry. But the existing `orbit_ingest` appears to write directly to Neo4j persons/interactions. This tension needs resolving.
4. **Seed population threshold.** Exact N for "WA DM ≥ N messages" — gut says 5, but the first sample will tell us.

## Five topology-diverse seeds the next session should run through the resolver

Picked to cover different failure modes:

| bucket | example | what it tests |
|---|---|---|
| high-volume cross-source | **Umayr** (already dossier'd) | baseline, skip |
| high-volume WA-only | top-20 sender with no Gmail / Calendar trail | single-source-is-first-class |
| LID-only sender | top-10 `@lid` with no phone in `whatsmeow_lid_map` | LID→phone bridge failure |
| Gmail-heavy | someone Sanchay emails more than WAs | Gmail-side entry point |
| dormant-turned-recent | quiet for 12mo, activity last 30d | going-cold / re-awakening |

## What I (the agent running this session) got wrong

Being honest so the next session doesn't repeat these:

1. **Conflated "is a relationship worth tracking?" with "is a cross-source candidate?"** Took Sanchay directly correcting me (*"if he only exists on WhatsApp, all the platforms consider him; if not, don't consider him. It's hurting my brain"*) to separate the two. Single-source is a valid terminal state, not a failure — this is now a project memory.
2. **Proposed building a local Python / Node resolver script in the orbit repo** — when CLAUDE.md turn zero, 01-vision.md, and 02-architecture.md all say OpenClaw is the founder-local agent runtime with the LLM budget and the tools. Took multiple rounds of correction (*"we have been talking about it since the start brother openclaw is the one that is here the agent that the founder brings in bro"*). The resolver is a `SKILL.md` on OpenClaw, nothing new in the orbit repo.
3. **Over-narrated architecture instead of showing data.** Sanchay had to say *"I still don't know how the data looks. What are the Lego blocks?"* before I went deep on Umayr. The lesson: data-first, always. A dossier on one human beats three paragraphs of synthesis.
4. **Drifted toward "rules first, LLM fallback"** after the architecture doc (and Sanchay) explicitly say rules-are-tools-the-LLM-calls. The correct framing: LLM drives from turn zero, rules are just tools.
5. **Generally proposed too much too fast.** Sanchay had to re-anchor to "sample-driven first — 5 humans, not 50" multiple times. Researchers don't start at scale; neither should we.

## Immediate starting point for the next session

1. Inspect `orbit_ingest` MCP tool signature (where is the MCP server? probably in the orbit repo as a standalone, or a separate package). Confirm whether it accepts observation shape with reasoning.
2. Draft `~/.openclaw/skills/orbit-resolve-identity/SKILL.md` — one file, instructions + tool compose over wacli + gog + orbit_ingest.
3. Install under `~/.openclaw/skills/`, run interactively on Wazowski for one seed (Umayr — already dossier'd, good control).
4. Inspect observation output. Iterate SKILL.md until clean.
5. Run the five topology seeds. Iterate again.
6. If it holds: re-enable a focused cron (one batch per run, not per-minute like the old one) that walks top-50 seeds.

## References from this session

Prior-art / context files consulted:
- `CLAUDE.md` (orbit repo)
- `agent-docs/01-vision.md`, `02-architecture.md`, `09-data-gathering-handoff.md`
- `/Users/sanchay/Documents/projects/personal/localhost/docs/04-OPENCLAW.md` (OpenClaw CLI reference)
- `/Users/sanchay/Documents/projects/personal/localhost/docs/12-DEPLOYMENT-STATUS.md` (VM inventory — stale 2026-03-21)
- `/Users/sanchay/Documents/projects/personal/localhost/pdds/whatsapp-pdd.md` (WhatsApp schema)
- `/Users/sanchay/Documents/projects/personal/localhost/.claude/worktrees/fervent-banach/orbit-experiment/` (REPORT.md, experiment.py, first_time_ingestion.py, data/raw/)
- VM: `/usr/lib/node_modules/openclaw/skills/wacli/SKILL.md`
- VM: `~/.openclaw/openclaw.json`, `~/.openclaw/cron/jobs.json`

Auto-memory entries created this session (in `~/.claude/projects/.../memory/`):
- `project_v0_scope.md`
- `project_single_source_valid.md`
- `project_provenance_principle.md`
