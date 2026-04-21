# agent-docs — index

These docs extend [CLAUDE.md](../CLAUDE.md). They're loaded on demand — decide which ones are relevant for your task before reading.

## Start here (as of 2026-04-20, post Stage-6-v4 + docs refresh)

**If you're opening the project cold, read these four docs in order:**

1. [16-how-it-works-end-to-end.md](./16-how-it-works-end-to-end.md) — **Single-sitting grasp of the whole product.** User journey (signup → agent install → data flow → query) + tech under the hood + honest evaluation. Written in a two-friends-explaining-to-founder tone.
2. [14-cleanup-2026-04-20.md](./14-cleanup-2026-04-20.md) — The audit + four-phase cleanup. **508 tests green + 1 skipped across 35 files. DB is 1,602 clean persons. Enriched endpoint live. Umayr byte-identical across every change.** What's built, what the debt is.
3. [15-future-props.md](./15-future-props.md) — Strategic inventory: end goal, unused signals, Stage 7 continuous loop, priorities, **and the case for Neo4j being first-class again.**
4. [11-v0-pipeline-handoff-2026-04-19.md](./11-v0-pipeline-handoff-2026-04-19.md) — V0 architecture narrative (observer → basket → resolver → card). Doc 14 supersedes count/status parts; this doc has the architecture narrative + CLI-is-plumbing invariant.

Then, if you need more depth:

5. [13-multi-tenant-onboarding.md](./13-multi-tenant-onboarding.md) — How to add a second founder (Hardeep, chad) when the time comes. Design-only until V0 dogfood proves.
6. [12-junk-filtering-system.md](./12-junk-filtering-system.md) — 3-layer junk-filtering design. Layer 1 (rules) + Layer 3 (heuristic) shipped in the 2026-04-20 cleanup; Layer 2 (agent-mutable blocklist) still future.
7. [10-eda-findings-2026-04-19.md](./10-eda-findings-2026-04-19.md) — Data recon that seeded V0. Topology seeds.
8. [03-current-state.md](./03-current-state.md) — Ground-truth snapshot (kept fresh per change).
9. [01-vision.md](./01-vision.md) + [02-architecture.md](./02-architecture.md) — Product frame + current multi-route V1 architecture.

**Two facts that'll save you rounds of correction:**
1. **OpenClaw is a public agent framework** (MIT, ~360k stars, Peter Steinberger, Nov 2025) — NOT Sanchay's product. Our Orbit stack runs ON it (plugins + SKILLs). DenchClaw (YC S24, dench.com) is another product on the same framework. Memory entry: `project_openclaw_is_a_public_framework.md`.
2. **Every write goes through the HTTP API**, never direct-DB. Non-negotiable. Memory entry: `project_api_is_only_writer.md`.

## When to read what

| File | Read when | Keywords |
|---|---|---|
| [17-resilient-worker-design.md](./17-resilient-worker-design.md) | Design for the shared batch-job library. **Precondition for Stage 7.** | progress file · retry · DLQ · circuit breaker · ETA |
| [16-how-it-works-end-to-end.md](./16-how-it-works-end-to-end.md) | **One-shot orientation.** Full product + tech walkthrough. | user journey · data flow · enrichment · Neo4j plan |
| [15-future-props.md](./15-future-props.md) | Strategic inventory — sources, improvements, continuous-loop, priorities. | goal · unused signals · Stage 7 loop · priorities |
| [14-cleanup-2026-04-20.md](./14-cleanup-2026-04-20.md) | **Starting a new session.** Post-cleanup state. | audit · wipe + re-ingest · safety rules · enriched endpoint · 508 tests · 1602 persons |
| [13-multi-tenant-onboarding.md](./13-multi-tenant-onboarding.md) | Planning to onboard Hardeep/chad. Design-only, not implemented. | RLS · `ORBIT_SELF_EMAIL` · API-key mint · npm skill-pack |
| [12-junk-filtering-system.md](./12-junk-filtering-system.md) | Touching safety/blocklist rules. Layer 1+3 landed; Layer 2 future. | bot regex · mega-lurker · broadcast-ratio · blocklist schema |
| [11-v0-pipeline-handoff-2026-04-19.md](./11-v0-pipeline-handoff-2026-04-19.md) | Architecture narrative (doc 14 supersedes counts). | V0 pipeline · observer · resolver · card · CLI plugin · bulk · continuous loop |
| [01-vision.md](./01-vision.md) | Before any design or feature conversation; when you need "why" | vision · moat · loop · packet · V0 framing |
| [02-architecture.md](./02-architecture.md) | Touching schema, routes, projection, identity, LLM split | V1 routes · observations basket · card assembler · rules-as-tools |
| [18-neo4j-edge-model-proposal.md](./18-neo4j-edge-model-proposal.md) | Designing the Neo4j projection — nodes, edges, weight formula, populate invariants | DM · SHARED_GROUP · EMAILED · MERGE · lid_phone_bridge · weight ln(1+count)·exp(-days/180) |
| [03-current-state.md](./03-current-state.md) | Ground-truth snapshot (routes, DB counts, scripts) | backend surface · data state · what's deleted · credentials |
| [06-operating.md](./06-operating.md) | Before any risky action; writing commits; running destructive ops | rules of engagement · standing authorities · verification log · commit template |
| [09-data-gathering-handoff.md](./09-data-gathering-handoff.md) | Historical — the brief that seeded the 2026-04-19 EDA session | claw VM · first_time_ingestion · 1% ceiling · seed identity · LLM-forward EDA |
| [10-eda-findings-2026-04-19.md](./10-eda-findings-2026-04-19.md) | Context on the dataset before the V0 pipeline work | VM state · data findings · Umayr dossier · wacli capture · design decisions · what went wrong |
| [archive/04-roadmap.md](./archive/04-roadmap.md) | **ARCHIVED** — pre-V0 6-track plan, superseded by doc 14/15 | historical · tracks · T3 · fixtures-as-contract |
| [archive/05-golden-packets.md](./archive/05-golden-packets.md) | **ARCHIVED** — Track 3 acceptance contract, no longer load-bearing | historical · packet fixtures · Imran/Aryan/Hardeep |

## How these relate to `docs/superpowers/`

- `agent-docs/*` — the narrative + pointer layer. Short, durable, lazy-loaded.
- `docs/superpowers/specs/` — canonical design + testing specs. Authoritative, but not a daily read.
- `docs/superpowers/plans/` — detailed execution plans per track. Open when working on that specific track.

If something is in both places, `docs/superpowers/` is authoritative. `agent-docs/` summarizes and points.

## Invariants

- Every file here stays under ~200 lines. Over that, split or prune. Some historical docs (10, 11, 15) exceed this; they're grandfathered.
- No code snippets — only `path/to/file:line` pointers. Inlined copies rot. Exception: handoff docs (11, 16) may include verified snippets as historical record.
- Update [03-current-state.md](./03-current-state.md) when the state changes. Append to its changelog; don't rewrite history.
- New files follow the `NN-short-name.md` numbering. Reserve the next number — don't reuse.
- Archived docs live under `agent-docs/archive/` with an "ARCHIVED — superseded by …" banner at the top.
