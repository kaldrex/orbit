# 01 · Vision

> What we're building and why. Read this when you need the "why" before touching "how."

## Who this is for

**Founders.** One human holding 30–150 active relationships across five to seven channels where those relationships actually happen — WhatsApp, Gmail, Google Workspace, Calendar, Slack, Linear, whatever comes next. Every CRM on the market pretends one person is one row per source. No tool available today lets a founder answer *"what do I actually know about Imran, across everything, right now?"* without staring at six tabs.

Orbit is that answer.

## The three-way loop

Orbit is one half of a two-part system. The other half is **OpenClaw**, an agent runtime that lives on the founder's own machine and holds the channel credentials. **Every founder brings their own OpenClaw** — their VM, their install, their LLM budget. OpenClaw owns the hands; Orbit owns the memory.

```
             HUMAN (the trigger)
                │
                ▼
            OpenClaw ◀──── Orbit
          (founder's agent) (memory)
                │              ▲
                │              │
                └── events ────┘
                  + observations
```

- **Orbit (memory)** — hosted. Canonical persons, cross-channel identity resolution, a graph of relationships, a typed history of agent observations. Humans log in to browse it. Agents call its APIs to read structured packets and write back learnings.
- **OpenClaw (hands)** — local to the founder. Owns channel connections via plugin CLIs (`wacli`, `gws`, etc.). Does real work — drafts, prep briefs, search — using the packet as input. Uses the founder's own LLM budget.
- **The human** — triggers everything. Every task they do or delegate generates signal. No triggers, no compounding.

Orbit is **not** the backend of one specific agent. It's the neutral surface where the human (via browser) and the agent (via API) both arrive. Each founder's data, each founder's agent, each founder's memory.

## Why Orbit pre-computes

OpenClaw *could* re-derive a person's state on every query — pull from Gmail, scan WhatsApp, stitch it together live. It has the tools. But that's slow and expensive every time the founder asks.

Orbit's job is to be **insanely good at storing and serving structured relationship data** so OpenClaw's answer to "what do I know about Imran" is a packet read, not a re-analysis. The rich reasoning happens once (during ingestion, or when new signal arrives) and Orbit caches the result.

This also sets the division of labor: **all LLM work lives on OpenClaw's side, on the founder's own budget.** Orbit does deterministic server-side processing — identity resolution, dedup, joins, quality checks, rule tools. No hosted LLM cost. No per-query LLM cost. Orbit serves pre-computed memory.

## Why the observation loop is the moat

A static relationship graph is a commodity — Clay, Attio, Affinity all get there. What compounds is **observations**: every time OpenClaw does work for the human, it writes back what it learned. Tone corrections. Segment hints. "This person is going cold." "These two records are the same human." "The founder is terser with investors." "The user said Aryan isn't cold, he's on vacation."

Each observation is one timestamped, confidence-scored, source-attributed record. Over months, the memory specifically adapts to this founder's world. That adaptation is hard to replicate and hard to leave.

**Without observations, Orbit is a nice address book. With them, it's defensible.**

Observations include **corrections from the human**, not just inferences from the agent. A user correction is a first-class observation kind, carrying higher trust than an LLM guess. Even before we build a correction UI, the data model treats that kind as real — adding observation kinds later is painful.

## The unit of value: the person packet

Not the graph. Not the feed. **One structured JSON record per human**, assembled by joining the graph layer + latest observations on read.

The packet is the **response contract** OpenClaw and the UI both consume. Its shape is stable (identity, channels, relationship, segment, context, optionally narrative + known-others). What's *in* it evolves as the underlying graph and observations grow.

The three fixtures in [tests/fixtures/golden-packets/](../tests/fixtures/golden-packets/) — Imran, Aryan, Hardeep — are **examples of the packet shape**, not acceptance contracts. They came from a pre-pivot analysis whose pipeline we rejected; we'll regenerate them once the new pipeline produces real output.

## The hard problem: cross-source identity

Cross-source identity resolution was at **~1%** in the pre-pivot analysis — most Gmail senders never linked to WhatsApp contacts. Same person appears as "Sanchay" on WhatsApp, `sanchay.t@...` on Gmail, `@san` on Slack. Some of that bridges with string-matching; most doesn't.

This is an **empirical problem, not a theoretical one**. We don't know what the patterns actually look like until we look. The approach: LLM on OpenClaw does the heavy inference against rich context; rules on Orbit accelerate obvious cases (same phone → auto-merge, domain classifiers, phone normalization). The specific algorithms, thresholds, and waterfalls are things to discover from real data — not prescribe from theory.

## V0 framing

> "Orbit gives you a unified card for every person you actually have cross-app activity with. Today, nine real humans. Grows as signal accumulates."

Not "unified graph." Not "intelligence platform." Not "AI CRM." **Unified cards for cross-app people.** Narrow and honest.

Three demo anchors — all real, from Sanchay's own data:

- **Imran Sable** — cross-source work partner, RISING trend, 1 phone + 2 emails merged
- **Aryan Yadav** — going-cold (18 days quiet), 150 interactions, specific unanswered questions preserved
- **Hardeep Gambhir** — internal teammate, 21 shared WhatsApp groups as `CO_PRESENT_IN` edges

## What this is not

- **Not a chatbot.** OpenClaw is the chat surface. Orbit is the memory it reads from.
- **Not a visual graph toy.** The graph view helps humans orient; the packet is the product.
- **Not multi-tenant yet.** One founder, their own OpenClaw, their own Orbit — until V0 lands. Multi-founder is a later product shape that reuses the same contracts.
- **Not mobile yet.** Desktop-first until cards render cleanly.

## Build philosophy

Build for **fit and correctness**, not speed-to-ship. When the data model is a graph and the roadmap has graph-native queries, use a graph database — don't work around it with a relational store "for now." When a problem is empirical, plan to experiment — don't prescribe algorithms from theory. Ship the right thing at the abstraction level the problem lives at. See [06-operating.md](./06-operating.md).

## Further reading

- Architecture (layers + contracts): [02-architecture.md](./02-architecture.md)
- Current state (what exists on disk today): [03-current-state.md](./03-current-state.md)
- Data flow (first-time bootstrap + monitoring): [07-data-flow.md](./07-data-flow.md) *(to be written)*
- Explicit open questions: [08-open-questions.md](./08-open-questions.md) *(to be written)*
