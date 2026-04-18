# 01 · Vision

> What we're building and why. Read this when you need the "why" before touching "how."

## Who this is for

**Founders.** One human, dozens of active relationships, five to seven channels where those relationships actually happen (WhatsApp, Gmail, Calendar, Slack, Linear, and whatever comes next). Every CRM pretends one person is one row. No CRM on the market lets a founder answer "what do I actually know about Imran, across everything, right now?" without staring at six tabs.

Orbit is that answer.

## The three-way loop

Orbit is one half of a two-part system. The other half is **OpenClaw**, an agent runtime that lives on the founder's machine and owns real channel connections.

```
           HUMAN (the trigger)
              │
              ▼
          OpenClaw ◀─────────── Orbit
          (hands)                (memory)
              │                    ▲
              │                    │
              └── observations ────┘
```

- **OpenClaw (hands)** — channel access, real-time acquisition, per-query reasoning, drafts, scheduling. Runs locally. Uses the founder's own LLM budget.
- **Orbit (memory)** — canonical people, identity resolution, cross-channel interactions, LLM-enriched summaries, the founder-facing UI. Runs hosted.
- **The human (trigger)** — every action the founder takes, or asks their agent to take, generates new signal. No activity, no compounding.

## Why inverted storage

Today's CRMs and "relationship graphs" go source → graph, one shot. Schema changes or new rules = reimport from source. That's expensive, slow, and loses audit data.

Orbit inverts: `raw_events` is the immutable ledger. Everything downstream (`interactions`, `persons`, the Neo4j graph, the packet cache) is a **rebuildable projection**. Add a field, change a rule, fix a classifier — rebuild from the ledger, don't re-fetch from Gmail. See [docs/superpowers/specs/2026-04-18-orbit-v0-design.md §2](../docs/superpowers/specs/2026-04-18-orbit-v0-design.md).

## Why the observation loop is the moat

A static relationship graph is a commodity — Clay, Attio, Affinity all get there. What compounds is **observations**: every time an OpenClaw agent does work for the human, it writes back what it learned. Tone corrections. Segment hints. "This person is going cold." "These two records are the same human." "The founder's reply style is terser with investors."

Each observation is one timestamped, confidence-scored row. Over months, the memory specifically adapts to this founder's world. That adaptation is hard to replicate and hard to leave.

**Without observations, Orbit is a nice address book. With them, it's defensible.**

### The mechanics (post-V0 vision)

The full story isn't just "observations compound." It's a three-tier system: **rules produce evidence packets** (messaging pattern, group co-presence, platform absence, calendar overlap, email-header signals, identity conflict evidence); **Orbit-side LLM reads evidence — not raw data** — and writes enriched packet fields (`recent_topics`, `outstanding_action_items`, `tone`); **OpenClaw-side LLM** reads packets for per-query work (drafts, prep, search). Cluster-first identity mapping (resolve the group-co-presence clusters first, use A's classification to inform B's) is the long-term shape. Track 4 is the first step; the full architecture is in [docs/archive/data-science/BRAINSTORM-intelligence-redesign.md](../docs/archive/data-science/BRAINSTORM-intelligence-redesign.md).

### The gap Imran's packet is evidence we can close

Cross-source identity resolution was at **~1%** before the 12-month Gmail widening — most Gmail senders never linked to WA contacts. [Imran's packet](../tests/fixtures/golden-packets/person_packet_imran.json) (1 phone + 2 emails → 1 person) is the first real proof the name-waterfall + merge rules can actually bridge channels. The breakthrough is fragile — the Google Contacts `contacts.other.readonly` scope (deferred per [design spec §10](../docs/superpowers/specs/2026-04-18-orbit-v0-design.md)) is what makes it robust at scale (2–3× the cross-source match rate). Don't treat cross-source resolution as solved; it's the hard problem and the one the product lives or dies on. Historical analysis in [docs/archive/data-science/REPORT.md](../docs/archive/data-science/REPORT.md).

## The unit of value: the person packet

Not the graph. Not the feed. **One structured JSON record per human**, combining cross-channel presence, relationship state, open questions, and LLM-enriched context. Three canonical shapes are committed at [tests/fixtures/golden-packets/](../tests/fixtures/golden-packets/). Track 3's assembler must diff-clean against those. See [05-golden-packets.md](./05-golden-packets.md).

## V0 framing

> "Orbit gives you a unified card for every person you actually have cross-app activity with. Today, nine real humans. Grows as signal accumulates."

Not "unified graph." Not "intelligence platform." Not "AI CRM." **Unified cards for cross-app people.** Narrow and honest.

Three demo anchors — all real, from Sanchay's actual data:

- **Imran Sable** — cross-source work partner, RISING trend, 2 emails linked to 1 phone (proves cross-channel identity resolution works)
- **Aryan Yadav** — going-cold (18 days quiet), 150 interactions, specific unanswered questions preserved (proves the memory notices what the human forgot)
- **Hardeep Gambhir** — internal teammate, 21 shared WhatsApp groups materialized as `CO_PRESENT_IN` edges (proves weak signal stays weak)

## What this is not

- **Not a chatbot.** OpenClaw is the chat surface. Orbit is the memory it reads from.
- **Not a visual graph toy.** A pretty constellation is nice; the packet is the product.
- **Not multi-tenant yet.** One founder at a time until V0 lands.
- **Not mobile yet.** Desktop-first until cards render cleanly on one screen.

## Further reading

- Full design spec (authoritative): [docs/superpowers/specs/2026-04-18-orbit-v0-design.md](../docs/superpowers/specs/2026-04-18-orbit-v0-design.md)
- Architecture in depth: [02-architecture.md](./02-architecture.md)
- Current state (what exists today): [03-current-state.md](./03-current-state.md)
