# Orbit Docs

Everything you need to pick up where the last session left off.

## Start here

**`handoff/README.md`** — Next-session entry point. Tells you the #1 problem to fix and where to look.

## Folder layout

```
docs/
├── README.md               ← this file
├── handoff/                ← current state + fix roadmap
│   ├── README.md                      entry point
│   ├── 01-system-overview.md          how Orbit works end-to-end
│   ├── 02-live-state.md               credentials, numbers, URLs
│   ├── 03-problems.md                 40 concrete issues from 3 audits
│   └── 04-next-steps.md               priority-ordered fix plan
└── data-science/           ← reference algorithms (Python, not deployed)
    ├── ENGINEER_HANDOFF.md            what the DS team built
    ├── REPORT.md                      validation results
    ├── BRAINSTORM-intelligence-redesign.md   future vision
    ├── intelligence_layer.py          scoring + canonical-name resolver (validated)
    ├── platform_rules.py              per-source cleaning rules
    └── first_time_ingestion.py        first-run classification pipeline
```

## Quick links — what lives where in the codebase

| Surface | Path |
|---|---|
| **Plugin** (runs on user's agent) | `packages/orbit-plugin/` |
| **Web app + API** | `src/app/` |
| **Core server logic** | `src/lib/` |
| **One-shot scripts** | `scripts/` |
| **OpenClaw marketplace entry** | `marketplace.json` (repo root) |

## The one thing to fix first

**Canonical Identity Resolution.** Ramon appears 3 times, Eric 3 times, Suhas 2 times. The rule-based resolver is validated in Python (`docs/data-science/intelligence_layer.py`) but not ported. Phase 1 in `handoff/04-next-steps.md` walks through the design.
