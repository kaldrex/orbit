# 02 — Live State (Deploy Locations, Numbers, Credentials)

## Deployed URLs

| Surface | URL |
|---|---|
| Production web app | https://orbit-mu-roan.vercel.app |
| Login | https://orbit-mu-roan.vercel.app/login |
| Onboarding | https://orbit-mu-roan.vercel.app/onboarding |
| Dashboard | https://orbit-mu-roan.vercel.app/dashboard |
| API base | https://orbit-mu-roan.vercel.app/api/v1 |
| GitHub repo | https://github.com/kaldrex/orbit |

## Credentials

### Web login
- **Email:** `sanchaythalnerkar@gmail.com`
- **Password:** `Sanchay@123`
- User ID: `dbb398c2-1eff-4eee-ae10-bad13be5fda7`
- Self-node in Neo4j: `user_728032c5`

### Wazowski API key
- `orb_live_zUm0eHCaPlVzvtDv1jsR6Y9WWzEKstEj`
- Set as `ORBIT_API_KEY` in `~/.openclaw/.env` on claw VM
- Stored hash in Supabase `api_keys` table

### Neo4j Aura
- URI: `neo4j+s://3397eac8.databases.neo4j.io`
- User: `3397eac8`
- Password: `h_RPg5ECyd2d5nKikS1NQIRS5VkzXQ2D-zq3YRN_xTM`
- Database: `3397eac8` (same as user on Aura)

### Supabase
- Project: `xrfcmjllsotkwxxkfamb` (org `zupoikjydnwhfivcunkv`)
- URL: `https://xrfcmjllsotkwxxkfamb.supabase.co`
- Anon key in `.env.local` of the orbit repo
- No service role key set up yet (known gap — capability store is in-memory)

### Vercel
- Account: `sanchaythalnerkar-8163` (Hobby tier)
- Project: `orbit`
- Deploy: `cd ~/Documents/projects/personal/orbit && vercel --prod --yes`
- No auto-deploy from GitHub pushes — manual only

## Graph state (as of last session end)

| Metric | Count |
|---|---|
| Person nodes (total) | 1,003 |
| INTERACTED edges | 9,153 |
| KNOWS edges | 46,956 |
| Self-node INTERACTED connected | 1,001 / 1,003 (1 self + 2 ghost Sanchay nodes) |
| Orphans (no edges) | 0 |

### Category distribution
| Category | Count | % |
|---|---|---|
| other | 909 | 90.6% |
| community | 29 | 2.9% |
| team | 21 | 2.1% |
| founder | 18 | 1.8% |
| friend | 11 | 1.1% |
| fellow | 6 | 0.6% |
| investor | 4 | 0.4% |
| sponsor | 4 | 0.4% |
| self | 1 | 0.1% |

### Score distribution
| Bucket | Count | % |
|---|---|---|
| score < 1.5 | 487 | 48.7% |
| 1.5 ≤ score < 2 | 446 | 44.6% |
| 2 ≤ score < 5 | 44 | 4.4% |
| score ≥ 5 | 23 | 2.3% |

Min: 1.1 • Max: 10.1 • Avg: 1.69

### Channel mix of INTERACTED edges
| Channel | Count |
|---|---|
| whatsapp_dm | 5,272 |
| whatsapp_group | 2,866 |
| whatsapp (legacy) | 140 |
| email | 84 |
| calendar | 44 |
| meeting | 34 |
| linear | 20 |
| slack | 8 |

### Cross-source coverage (the big gap)
- WhatsApp-only contacts: 858 (85.7%)
- Calendar/meeting-only: 74 (7.4%)
- Multi-channel: only 51 (5.1%)
- Other single-channel: 19 (1.9%)

**Only ~5% of contacts are linked across 2+ sources.** The rest are siloed.

## Wazowski (claw VM)

### Access
```bash
ssh claw  # password-less, key-based
# host: openclaw-sanchay.asia-south1-a.c.cyphersol-prod.internal (GCP Asia-South1)
```

### Plugin location
- `/home/sanchay/.openclaw/plugins/orbit-connector/`
- Package `@orbit/plugin` v0.2.0
- better-sqlite3 installed locally for wacli DB access

### OpenClaw version
- Binary: `/usr/bin/openclaw` — v2026.4.11
- Gateway service: `openclaw-gateway.service` (systemd user unit), currently running v2026.4.5

### Config
- `~/.openclaw/openclaw.json` — the main config
- `~/.openclaw/.env` — environment variables (ORBIT_API_KEY, LINEAR_API_TOKEN, Slack tokens, etc.)
- `~/.orbit/bootstrap.json` — per-connector bootstrap state (delete to force re-run)

### Data sources on claw
- `~/gowa/storages/` — 225 JSON files, ~62k WhatsApp messages in RECENT + INITIAL_BOOTSTRAP files
- `~/.wacli/wacli.db` — 2,056 contact names in SQLite
- Google Workspace via `gws` CLI (Calendar + Gmail — auth stored in OS keyring)
- Linear via `LINEAR_API_TOKEN` env var
- Slack via `SLACK_BOT_TOKEN` env var (in channels.slack config)

### Bootstrap results last run
| Connector | Signals generated |
|---|---|
| WhatsApp | 28,275 |
| Calendar | 112 |
| Gmail | 5 (after newsletter filter expansion) |
| Linear | 48 |

## Git state

```
Repo: github.com/kaldrex/orbit
Branch: main
Latest commits (top to bottom, newest first):
  aa22759 fix: expand Gmail newsletter filter
  a998b59 fix: Gmail YYYY/MM/DD format, Linear DateTime
  a677973 fix: execFileSync maxBuffer for gws
  b989e1e fix: gws CLI --params JSON syntax
  a55f1ad fix: WhatsApp bootstrap unwraps GOWA envelope
  3a9306c perf: signal-buffer 5s/500 per flush
  4c25613 fix: signal-buffer day-bucket dedup
  a0199bd fix: realtime connectors bootstrap + capability detection
  1f95f89 fix: /api/v1/capabilities (not /api/capabilities)
  e71520a fix: plugin id orbit-connector
  7a4bb09 fix: auto-discover OpenClaw plugin-entry
  4cda40c fix: plugin manifest configSchema
  38dc30a fix: add openclaw.extensions
  5b4b4cd feat: founder-ready plugin + onboarding + graph quality fixes
```

## Files that matter

### Plugin
- `packages/orbit-plugin/index.js` — entry
- `packages/orbit-plugin/openclaw.plugin.json` — manifest
- `packages/orbit-plugin/SKILL.md` — agent instructions
- `packages/orbit-plugin/lib/*.js` — 7 support modules
- `packages/orbit-plugin/connectors/*/connector.js` — 5 connectors

### Server
- `src/app/api/v1/*` — 10+ API routes
- `src/app/api/graph/route.ts` — dashboard graph query (separate from /v1/graph)
- `src/lib/scoring.ts` — scoring engine
- `src/lib/neo4j.ts` — batch helpers
- `src/app/dashboard/page.tsx` — main UI
- `src/app/onboarding/page.tsx` + `OnboardingClient.tsx` — install flow

### Scripts
- `scripts/cleanup-migration.js` — one-shot Neo4j cleanup (orphans, dupes, false edges, category normalization)

## Marketplace

```bash
openclaw plugins install orbit --marketplace kaldrex/orbit --dangerously-force-unsafe-install
```

The `--dangerously-force-unsafe-install` flag is required because the plugin uses `child_process` (to call `gws` and `openclaw agent`) and env-var + network-send (legitimate API auth), which OpenClaw's security scanner flags as suspicious.

## What you can do right now

```bash
# See the graph
open https://orbit-mu-roan.vercel.app/dashboard

# Query Neo4j directly (for audits)
cd ~/Documents/projects/personal/orbit && node -e "
const neo4j = require('neo4j-driver');
const d = neo4j.driver('neo4j+s://3397eac8.databases.neo4j.io', neo4j.auth.basic('3397eac8', 'h_RPg5ECyd2d5nKikS1NQIRS5VkzXQ2D-zq3YRN_xTM'));
...
"

# Watch plugin activity
ssh claw "journalctl --user -u openclaw-gateway --since '5 minutes ago' -f | grep orbit"

# Force re-bootstrap (wipes state, plugin re-ingests on next restart)
ssh claw "rm -f ~/.orbit/bootstrap.json && systemctl --user restart openclaw-gateway.service"

# Deploy latest code
cd ~/Documents/projects/personal/orbit && vercel --prod --yes

# Push plugin changes to Wazowski
rsync -az --exclude node_modules ~/Documents/projects/personal/orbit/packages/orbit-plugin/ claw:~/.openclaw/plugins/orbit-connector/
```
