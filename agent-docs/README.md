# agent-docs — index

These docs extend [CLAUDE.md](../CLAUDE.md). They're loaded on demand — decide which ones are relevant for your task before reading.

## When to read what

| File | Read when | Keywords |
|---|---|---|
| [01-vision.md](./01-vision.md) | Before any design or feature conversation; when you need "why" | vision · moat · loop · packet · V0 framing |
| [02-architecture.md](./02-architecture.md) | Touching schema, routes, projection, identity, LLM split | 3 contracts · raw_events · classification · identity waterfall |
| [03-current-state.md](./03-current-state.md) | Starting a session; before taking destructive action | backend surface · data state · what's deleted · credentials |
| [04-roadmap.md](./04-roadmap.md) | Planning work; deciding what to ship next | tracks · dependencies · T3 sub-tasks · T2.5 |
| [05-golden-packets.md](./05-golden-packets.md) | Implementing Track 3 — packet assembler or `/packet` route | diff contract · fixtures · schema · Imran/Aryan/Hardeep |
| [06-operating.md](./06-operating.md) | Before any risky action; writing commits; running destructive ops | rules of engagement · standing authorities · verification log · commit template |

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
