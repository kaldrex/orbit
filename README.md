# Orbit

Relationship intelligence for founders. Your OpenClaw agent ingests WhatsApp + Gmail + Calendar + Slack + Linear into a scored graph, delivered back to you through your existing messaging apps.

**Live:** https://orbit-mu-roan.vercel.app

## Start here

👉 **[`docs/handoff/README.md`](docs/handoff/README.md)** — Current state, open issues, and the priority fix plan. Start every new session by reading this.

## Architecture

```
User's OpenClaw agent (Wazowski, etc.)
  └── orbit-connector plugin ──► POST /api/v1/ingest ──► Neo4j
                                                          │
                            Human dashboard ◄─────────────┘
                           (orbit-mu-roan.vercel.app)
```

Two surfaces, one repo:

| Path | What it is |
|---|---|
| `src/` | Web app + server API (Next.js on Vercel) |
| `packages/orbit-plugin/` | OpenClaw plugin deployed to each user's agent |
| `docs/` | Architecture, current state, open issues, fix plan |
| `scripts/` | One-shot migrations & cleanup |

## Data stores

- **Neo4j Aura** — the graph (Person nodes + INTERACTED + KNOWS)
- **Supabase** — auth, profiles, API keys

## Deploy

```bash
# Web app
vercel --prod --yes

# Plugin to Wazowski (after changes)
rsync -az --exclude node_modules packages/orbit-plugin/ claw:~/.openclaw/plugins/orbit-connector/
ssh claw "systemctl --user restart openclaw-gateway.service"
```

## Local dev

```bash
npm install
npm run dev       # http://localhost:3456
```

Requires `.env.local` with Neo4j + Supabase credentials — see `docs/handoff/02-live-state.md`.

## Install the plugin on your OpenClaw agent

```bash
openclaw plugins install orbit --marketplace Sanchay-T/orbit --dangerously-force-unsafe-install
openclaw env set ORBIT_API_KEY=<key-from-dashboard>
```

(`--dangerously-force-unsafe-install` is required because the plugin uses `child_process` to call `gws` and sends env vars in API auth headers — both legitimate, both flagged by OpenClaw's security scanner.)
