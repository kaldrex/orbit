# agent-docs — index

These docs extend [CLAUDE.md](../CLAUDE.md). They're loaded on demand — decide which ones are relevant for your task before reading.

## Start here (as of 2026-04-19, post-V0-pipeline session)

**If you're opening the project cold, read this one doc first:**

1. [11-v0-pipeline-handoff-2026-04-19.md](./11-v0-pipeline-handoff-2026-04-19.md) — The V0 pipeline (observer → basket → resolver → card) is built, tested, and proven on 2 real humans. 108 tests green, 8 commits on worktree branch. This doc covers what's built, what's verified, what's live on claw, what's next (orbit CLI plugin → bulk ingest → continuous loop → UI), and the principles we locked. **Single most important doc for the next session.**

Then, if you need more depth on prior decisions:

2. [10-eda-findings-2026-04-19.md](./10-eda-findings-2026-04-19.md) — Data recon from before the V0 pipeline work. Topology seeds, Umayr's original dossier.
3. [03-current-state.md](./03-current-state.md) — Pre-V0 state snapshot (outdated on routes/DB — see the handoff doc above for current).
4. [01-vision.md](./01-vision.md) + [02-architecture.md](./02-architecture.md) — Product frame + three-contracts architecture; re-read if re-grounding.

**One fact that will save you a round of correction:** OpenClaw is the founder-local agent runtime that brings its own LLM budget and its own channel tools (wacli, gog, etc.). Orbit is the memory store OpenClaw reads from and writes observations back to. The identity-resolver is a **SKILL.md on OpenClaw**, not a side-script in the Orbit repo. Do not propose a parallel Python/Node resolver. This was the repeated miss last session.

## When to read what

| File | Read when | Keywords |
|---|---|---|
| [11-v0-pipeline-handoff-2026-04-19.md](./11-v0-pipeline-handoff-2026-04-19.md) | **Starting a new session.** Most recent + complete picture. | V0 pipeline · observer · resolver · card · CLI plugin · bulk · continuous loop · next-session plan |
| [01-vision.md](./01-vision.md) | Before any design or feature conversation; when you need "why" | vision · moat · loop · packet · V0 framing |
| [02-architecture.md](./02-architecture.md) | Touching schema, routes, projection, identity, LLM split | 3 contracts · raw_events · classification · identity waterfall |
| [03-current-state.md](./03-current-state.md) | Pre-V0 snapshot. Outdated on routes/DB — **see doc 11 for current state**. | backend surface · data state · what's deleted · credentials |
| [04-roadmap.md](./04-roadmap.md) | Planning work; deciding what to ship next | tracks · dependencies · T3 sub-tasks · T2.5 |
| [05-golden-packets.md](./05-golden-packets.md) | Implementing Track 3 — packet assembler or `/packet` route (fixtures are shape-examples, not acceptance — see 01-vision) | diff contract · fixtures · schema · Imran/Aryan/Hardeep |
| [06-operating.md](./06-operating.md) | Before any risky action; writing commits; running destructive ops | rules of engagement · standing authorities · verification log · commit template |
| [09-data-gathering-handoff.md](./09-data-gathering-handoff.md) | Historical — the brief that seeded the 2026-04-19 EDA session | claw VM · first_time_ingestion · 1% ceiling · seed identity · LLM-forward EDA |
| [10-eda-findings-2026-04-19.md](./10-eda-findings-2026-04-19.md) | Context on the dataset before the V0 pipeline work | VM state · data findings · Umayr dossier · wacli capture · design decisions · what went wrong |

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
