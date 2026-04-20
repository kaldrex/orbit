# 09 · Data-Gathering Session Hand-off

> **STATUS: historical (2026-04-18 handoff). Superseded by [10-eda-findings-2026-04-19.md](./10-eda-findings-2026-04-19.md) and [11-v0-pipeline-handoff-2026-04-19.md](./11-v0-pipeline-handoff-2026-04-19.md).** Retained as the brief that seeded the EDA session.
>
> Brief for the next session, dedicated to **understanding the data** before
> we design schemas, wire shapes, or connector logic. Read in full before
> SSH'ing or inspecting anything.
>
> Scope: EDA only. This session does **not** implement ingestion, write
> schemas, or reproduce the 2026-04-16 pipeline. See "The trap" below.

## Why this session exists

The 2026-04-19 redesign (see [01-vision.md](./01-vision.md),
[02-architecture.md](./02-architecture.md)) ships with one open surface: the
data layer. Before we design `persons` / `edges` / `observations`, settle
the wire shape for `raw_events`, or pick the rule-tool surface, we need to
look at what's actually on disk and what OpenClaw can actually emit.

## What's already known (do not re-derive)

The `localhost/` project at `/Users/sanchay/Documents/projects/personal/localhost/`
contains validated prior work:

- `docs/12-DEPLOYMENT-STATUS.md` — both Mumbai VMs as of 2026-03-21: SSH
  paths, ports, tokens, installed software. **Authoritative source for
  the access surfaces below.**
- `docs/04-OPENCLAW.md` — OpenClaw CLI reference (channels, skills, hooks,
  webhooks, memory).
- `pdds/whatsapp-pdd.md` — WhatsApp data shape: `messages.db` +
  `whatsapp.db`, JID formats, LID mapping, full schema.
- `.claude/worktrees/fervent-banach/orbit-experiment/REPORT.md` —
  2026-04-16 PoC on Sanchay's data. 62,155 WhatsApp msgs · 715 calendar
  events · 100 emails. **Cross-source match rate: 1.0%.**
- `.../orbit-experiment/first_time_ingestion.py` — the pipeline that
  pulled the data. Read end-to-end; it's the best documentation of how
  data was extracted last time.
- `.../orbit-experiment/data/raw/` — actual raw files from the claw VM.

## Access surfaces

### Claw VM (Sanchay's OpenClaw)

```bash
gcloud compute ssh openclaw-sanchay \
  --zone=asia-south1-a \
  --project=cyphersol-prod
# e2-medium · 34.14.170.5 · Ubuntu 24.04 LTS
# Hooks token: e1a5f1c2d105b15b9c1993e7091489880e74fc11864356617afa00a05c43bfd9
```

Snapshot is 2026-03-21 ("running, healthy, no Telegram bot"). A month
stale — verify what's actually installed before building on it. For the
canonical up-to-date reference see
`/Users/sanchay/Documents/projects/personal/localhost/docs/12-DEPLOYMENT-STATUS.md`.

### Orbit Postgres (ledger)

33,105 `raw_events` rows from the one-shot `wacli.db` bootstrap.
Connection in `.env.local`. Inspect for distribution, shape, coverage.

### Orbit Neo4j Aura

Connection in `.env.local`. `persons` / `edges` empty per the 2026-04-18
clean-slate — don't be surprised.

## Questions this session should answer

1. **What's installed on the claw VM today?** `wacli`? `gws`? Residual
   orbit-plugin code? Data left over from the 2026-04-16 experiment?
2. **What does the current `raw_events` table actually look like?**
   Per-sender distribution, field coverage, text-content health, date
   range, gaps.
3. **Which channels have been ingested, and which haven't?** Inventory
   against the data sources table in [02-architecture.md](./02-architecture.md).
4. **Where does the data sit in the heuristic pipeline's 1% failure
   mode?** Pick 20–50 specific cross-source pairs the 2026-04-16 pipeline
   missed. For each, write one line: *what context would a human — or an
   LLM seeing the same pair — use to make the identity call?*

## The trap

The 2026-04-16 artifacts are a **cautionary tale, not a starting point**.
That pipeline hit 1% cross-source on your own data. If this session
re-runs the same pipeline, measures the same overlap, and reports "1%
again" — it has wasted the session.

The purpose is to sit with the data in an **LLM-forward posture**: assume
LLM reasoning is available at inference time, and ask what signal a human
examining the same message pair would use to make an identity call.
That's the shape of the new architecture.

Heuristics stay — phone normalization, domain classification, LID mapping —
because they're cheap accelerators. They're no longer the pipeline's core.
The core is what the LLM sees and decides.

## Seed identity — the one concrete candidate

The 2026-04-16 experiment's sharpest finding: 30–50 human-provided
`(email, phone, jid)` bridges unlock cross-source resolution. In an
LLM-forward world, the LLM may be able to *infer* these bridges from
message content. Worth confirming that inference is feasible before
assuming. Flag every pair where bridge data would have been obvious to a
human as "LLM-infer candidate."

## Suggested first moves

1. SSH into the claw VM; audit installed binaries and any residual data.
2. Read `first_time_ingestion.py` end-to-end.
3. Pull a small fresh sample across sources (~7 days: WhatsApp + Gmail +
   Calendar) into a scratch dir on the claw VM.
4. Inspect Orbit's `raw_events` table directly (shape, distribution,
   coverage, UTF-8 health).
5. Hand-pick ~20 cross-source pairs the heuristics missed; for each, a
   one-liner on what context would resolve it.

## What to produce

A short EDA note. Not code. Not schemas. The output is **what we now know
about the data that we didn't before**, framed so schema design can start
with grounded intuition rather than theory.

## Related

- [01-vision.md](./01-vision.md) — product framing, why LLM-forward
- [02-architecture.md](./02-architecture.md) — three contracts, two
  stores, rules-as-tools surface
- `localhost/` — all prior artifacts referenced above
