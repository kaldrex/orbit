# agent-docs — index

These docs extend [CLAUDE.md](../CLAUDE.md). They're loaded on demand — decide which ones are relevant for your task before reading.

## Start here (as of 2026-04-19)

**If you're opening the project cold, read these three, in order:**

1. [10-eda-findings-2026-04-19.md](./10-eda-findings-2026-04-19.md) — the current session handoff. What we know about the data, what's locked, what the next session does, and what the last agent got wrong. **Most important single doc right now.**
2. [03-current-state.md](./03-current-state.md) — VM / Postgres / Neo4j state, post-cleanup.
3. [01-vision.md](./01-vision.md) + [02-architecture.md](./02-architecture.md) — why and what, if you need to re-ground.

**One fact that will save you a round of correction:** OpenClaw is the founder-local agent runtime that brings its own LLM budget and its own channel tools (wacli, gog, etc.). Orbit is the memory Store OpenClaw reads from and writes observations back to. The identity-resolver is a **SKILL.md on OpenClaw**, not a side-script in the Orbit repo. Do not propose a parallel Python/Node resolver. This was the repeated miss last session.

## When to read what

| File | Read when | Keywords |
|---|---|---|
| [01-vision.md](./01-vision.md) | Before any design or feature conversation; when you need "why" | vision · moat · loop · packet · V0 framing |
| [02-architecture.md](./02-architecture.md) | Touching schema, routes, projection, identity, LLM split | 3 contracts · raw_events · classification · identity waterfall |
| [03-current-state.md](./03-current-state.md) | Starting a session; before taking destructive action | backend surface · data state · what's deleted · credentials |
| [04-roadmap.md](./04-roadmap.md) | Planning work; deciding what to ship next | tracks · dependencies · T3 sub-tasks · T2.5 |
| [05-golden-packets.md](./05-golden-packets.md) | Implementing Track 3 — packet assembler or `/packet` route (fixtures are shape-examples, not acceptance — see 01-vision) | diff contract · fixtures · schema · Imran/Aryan/Hardeep |
| [06-operating.md](./06-operating.md) | Before any risky action; writing commits; running destructive ops | rules of engagement · standing authorities · verification log · commit template |
| [09-data-gathering-handoff.md](./09-data-gathering-handoff.md) | Historical — the brief that seeded the 2026-04-19 EDA session | claw VM · first_time_ingestion · 1% ceiling · seed identity · LLM-forward EDA |
| [10-eda-findings-2026-04-19.md](./10-eda-findings-2026-04-19.md) | Starting a session; looking up what was decided / found / flagged on 2026-04-19 | VM state · data findings · Umayr dossier · wacli capture · design decisions · what went wrong |

## How these relate to `docs/superpowers/`

- `agent-docs/*` — the narrative + pointer layer. Short, durable, lazy-loaded.
- `docs/superpowers/specs/` — canonical design + testing specs. Authoritative, but not a daily read.
- `docs/superpowers/plans/` — detailed execution plans per track. Open when working on that specific track.

If something is in both places, `docs/superpowers/` is authoritative. `agent-docs/` summarizes and points.

## Invariants

- Every file here stays under ~120 lines. Over that, split or prune.
- No code snippets — only `path/to/file:line` pointers. Inlined copies rot.
- Update [03-current-state.md](./03-current-state.md) when the state changes. Append to its changelog; don't rewrite history.
- New files follow the `NN-short-name.md` numbering. Reserve the next number — don't reuse.
