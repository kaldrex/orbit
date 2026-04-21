# agent-docs — index

These docs extend [CLAUDE.md](../CLAUDE.md). Load on demand.

## Start here (as of 2026-04-21, post V1 landing)

**If you're opening the project cold, read these in order:**

1. **[19-handoff-2026-04-21.md](./19-handoff-2026-04-21.md)** — current V1 state + non-negotiables + how to run it locally + what NOT to do. **THIS IS THE ENTRY POINT.**
2. [16-how-it-works-end-to-end.md](./16-how-it-works-end-to-end.md) — single-sitting grasp of the whole product (user journey + tech under the hood).
3. [01-vision.md](./01-vision.md) — product "why" in one page.
4. [02-architecture.md](./02-architecture.md) — V1 route surface + rules-as-tools + LLM split.

For full current counts + every route / RPC / migration / claw-file: see `outputs/state-snapshot-2026-04-21.md`.

**Two facts that'll save you rounds of correction:**
1. **OpenClaw is Peter Steinberger's public agent framework** (MIT, ~360k stars). NOT Sanchay's product. Our Orbit stack runs ON it (plugins + SKILLs). DenchClaw (YC S24) is a separate product on the same framework.
2. **API is the only writer.** Every write goes through `/api/v1/*`. Every Anthropic call lives inside a SKILL on claw, using the founder's budget. A Vitest regression test (`tests/unit/no-anthropic-outside-skills.test.mjs`) fails the build if anyone reintroduces the anti-pattern.

## When to read what

| File | Read when |
|---|---|
| [19-handoff-2026-04-21.md](./19-handoff-2026-04-21.md) | **Starting a new session.** Current V1 state, non-negotiables, how to run. |
| [16-how-it-works-end-to-end.md](./16-how-it-works-end-to-end.md) | One-shot orientation — user journey + tech walkthrough. |
| [15-future-props.md](./15-future-props.md) | Strategic inventory. Several items here SHIPPED during V1 (LID bridge, Neo4j populate, Stage 7 cron, Haiku port); others remain (call metadata, reactions, curation verbs). |
| [13-multi-tenant-onboarding.md](./13-multi-tenant-onboarding.md) | Onboarding a second founder (Hardeep / Khushal / Chandan). |
| [12-junk-filtering-system.md](./12-junk-filtering-system.md) | Touching safety/blocklist rules. Layers 1 + 3 shipped; Layer 2 (agent-mutable blocklist) still future. |
| [11-v0-pipeline-handoff-2026-04-19.md](./11-v0-pipeline-handoff-2026-04-19.md) | V0 architecture narrative (observer → basket → resolver → card). Counts superseded; architecture still load-bearing. |
| [03-current-state.md](./03-current-state.md) | Ground-truth snapshot (routes, DB counts, scripts). |
| [02-architecture.md](./02-architecture.md) | Schema, routes, projection, identity, LLM split. |
| [01-vision.md](./01-vision.md) | The "why". |
| [06-operating.md](./06-operating.md) | Before any risky action; verification-log format; commit template. |
| [18-neo4j-edge-model-proposal.md](./18-neo4j-edge-model-proposal.md) | Graph model (SHIPPED). Weight formula, prune semantics, open product questions. |
| [17-resilient-worker-design.md](./17-resilient-worker-design.md) | Batch-job library (SHIPPED). Resume, retry, DLQ, circuit breaker. |
| [archive/*](./archive/) | Historical sessions. 04-roadmap, 05-golden-packets, 09-data-gathering-handoff, 10-eda-findings, 14-cleanup-2026-04-20. Retained for audit; not for daily reading. |

## Evidence + state

- Live state snapshot: `outputs/state-snapshot-2026-04-21.md`
- Full audit (6 reports): `outputs/audit-2026-04-21/`
- Evidence trail: `outputs/verification-log.md`
- Canary baseline: `outputs/verification/2026-04-19-umayr-v0/card.json`

## Invariants

- Every file stays ≤ 200 lines. Over that, split or prune.
- No code snippets — only `path/to/file:line` pointers. Inlined copies rot. Exception: handoff docs (11, 16, 19) may include verified snippets as historical record.
- Update [03-current-state.md](./03-current-state.md) when the state changes. Append to its changelog; don't rewrite history.
- New files follow the `NN-short-name.md` numbering. Reserve the next number; don't reuse.
- Archived docs live under `agent-docs/archive/`.
