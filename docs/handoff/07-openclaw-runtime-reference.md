# 07 — OpenClaw Runtime Reference For Orbit

## Why this exists

We keep needing the same mental model:

- what OpenClaw owns
- what the Orbit plugin owns
- what Orbit server owns
- where config, state, and drift actually live

This doc is the working reference for that boundary.

It is meant to reduce re-discovery during planning, debugging, and product
design.

## Core model

OpenClaw is the local runtime.

Orbit is the canonical relationship system.

The Orbit plugin is the bridge between them.

That means:

- OpenClaw owns channel connections, sessions, routing, plugin execution, local
  workers, and local tool delivery.
- The Orbit plugin owns source-specific extraction, normalization, buffering,
  and Orbit API calls.
- Orbit server owns canonical entity truth, graph storage, identity resolution,
  scoring, and founder-facing product surfaces.

## What OpenClaw Gateway owns

In the current deployment model, the OpenClaw Gateway is the execution host for
the Orbit plugin.

Practically, that means the agent-side runtime owns:

- connector lifecycle
- plugin tool registration
- background workers
- capability reporting
- local LLM access
- proactive message delivery

For Orbit specifically, the gateway does **not** talk to Neo4j or Supabase
directly. It only talks to Orbit's HTTP API surface.

Observed current behavior:

- Gateway service: `openclaw-gateway.service`
- Local LLM endpoint used by Orbit workers:
  `http://127.0.0.1:18789/v1/chat/completions`
- Agent-side delivery path used by proactive features:
  `openclaw agent --deliver`

## Where config, workspace, and state live

The important paths are:

- OpenClaw runtime config:
  `~/.openclaw/openclaw.json`
- OpenClaw env/secrets:
  `~/.openclaw/.env`
- OpenClaw managed state, credentials, and sessions:
  `~/.openclaw/...`
- Orbit plugin working state:
  `~/.orbit/bootstrap.json`
- Orbit plugin deployment on host:
  `~/.openclaw/plugins/orbit-connector/`

Important agent-side source inputs used by current connectors:

- WhatsApp contact/state DB:
  `~/.wacli/wacli.db`
- WhatsApp history/bootstrap files:
  `~/gowa/storages/`

The practical distinction:

- `~/.openclaw/` is runtime/state/secrets territory.
- Orbit repo code is product code.
- The founder product should not depend on manual editing inside those runtime
  directories.

## How plugins and skills load

### Marketplace path

The primary product plugin path in this repo is marketplace-backed.

Repo file:

- [marketplace.json](/Users/sanchay/Documents/projects/personal/orbit/marketplace.json)

This points the public `orbit` plugin to:

- [packages/orbit-plugin](/Users/sanchay/Documents/projects/personal/orbit/packages/orbit-plugin)

### Full product plugin

Repo files:

- [packages/orbit-plugin/package.json](/Users/sanchay/Documents/projects/personal/orbit/packages/orbit-plugin/package.json)
- [packages/orbit-plugin/openclaw.plugin.json](/Users/sanchay/Documents/projects/personal/orbit/packages/orbit-plugin/openclaw.plugin.json)
- [packages/orbit-plugin/index.js](/Users/sanchay/Documents/projects/personal/orbit/packages/orbit-plugin/index.js)

This is the full OpenClaw-native deployment artifact.

It includes:

- connectors
- bootstrap/state handling
- capability reporting
- 9 tools
- background workers
- richer identity/graph logic

Its plugin id is:

- `orbit-connector`

### Legacy/manual-load plugin

Repo files:

- [packages/openclaw-plugin/package.json](/Users/sanchay/Documents/projects/personal/orbit/packages/openclaw-plugin/package.json)
- [packages/openclaw-plugin/index.js](/Users/sanchay/Documents/projects/personal/orbit/packages/openclaw-plugin/index.js)

This is a lighter plugin family with id:

- `orbit-saas`

It is a compact SaaS bridge with core read/write tools and manual load wiring
rather than the current marketplace-first path.

## Current repo mapping

### `packages/orbit-plugin`

This should be treated as the main product plugin.

Responsibilities:

- detect and use locally available sources
- normalize source events into Orbit-shaped payloads
- preserve strong identifiers where possible
- flush normalized batches to `/api/v1/ingest`
- expose Orbit read/write tools back into OpenClaw
- run useful local workers like briefs and digests

### `packages/openclaw-plugin`

This should be treated as a secondary/legacy bridge path unless we explicitly
choose to keep both plugin families.

Today it creates conceptual drift because it overlaps with the full product
plugin but does not represent the main onboarding path.

## Session/auth/routing model as it affects Orbit

On the Orbit server side, the main agent-facing routes use dual-mode auth:

- API key first via `Authorization: Bearer orb_live_*`
- session fallback via browser auth

Relevant file:

- [src/lib/api-auth.ts](/Users/sanchay/Documents/projects/personal/orbit/src/lib/api-auth.ts)

This means:

- `/api/v1/*` is the plugin/agent surface
- `/api/*` includes dashboard-only session routes

Important distinction:

- `/api/v1/graph` is stats-oriented and accepts API key/session auth
- `/api/graph` is the full dashboard graph payload and is session-only

That split matters when deciding what belongs to the founder UI versus what
belongs to the plugin/agent contract.

## What Orbit should assume about OpenClaw

The safe assumptions are:

- OpenClaw is the local source runtime
- plugin code runs on the user's machine/VM
- source credentials live there
- source-specific files and local tools live there
- Orbit receives normalized facts over HTTP

Orbit should **not** assume:

- direct access to source-provider APIs from the Orbit server
- direct access to the user's local channel state from the Orbit server
- that every source has equally strong identity signals

## Current drift and cleanup notes

There is active configuration drift between the full product plugin and the
legacy plugin family.

Observed drift:

- production host still has stale `orbit-saas` artifacts/config remnants
- `tools.alsoAllow` drift can reference `orbit-saas` even when
  `orbit-connector` is the real active plugin
- repo still contains both plugin families, which can confuse future sessions

Working recommendation:

- treat `orbit-connector` as canonical unless there is a strong reason to keep
  both
- document the purpose of `orbit-saas` explicitly if it remains
- avoid letting stale OpenClaw config define the future product boundary

## Design takeaway

The correct system split is:

- OpenClaw = runtime, connectors, channel presence, local actions
- Orbit plugin = universal bridge
- Orbit backend = canonical relationship truth

That is the cleanest path to the actual product vision:

"User connects OpenClaw once, Orbit begins building a useful relationship
system automatically, and the system works for other people without hand-tuned
per-user hacks."

## References

Official OpenClaw docs that informed this model:

- `https://github.com/openclaw/openclaw/blob/main/docs/index.md`
- `https://github.com/openclaw/openclaw/blob/main/docs/gateway/configuration-reference.md`
- `https://github.com/openclaw/openclaw/blob/main/docs/concepts/agent-workspace.md`
- `https://github.com/openclaw/openclaw/blob/main/docs/tools/skills.md`
