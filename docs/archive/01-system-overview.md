# 01 — How Orbit Works (End-to-End)

## The big picture

Orbit is a relationship intelligence platform. One person (Sanchay, the founder) runs an OpenClaw agent (Wazowski) on a GCP VM. The Orbit plugin inside Wazowski reads his WhatsApp history, Gmail, Calendar, Linear, and Slack, and streams structured signals to the Orbit web API. The API stores everything in Neo4j and serves a constellation UI where he can see his network.

Three surfaces, one brain:
- **The plugin** (lives on user's machine): extracts data, cleans it, dedups, buffers, ships
- **The web app** (Vercel): stores signals in Neo4j + Supabase, serves dashboard UI
- **The agent tools** (8 of them): let Wazowski query the graph during conversations

## Plugin architecture (`~/.openclaw/plugins/orbit-connector/`)

### Entry
`index.js` — Registers 8 tools with OpenClaw, spins up connectors, boots capability-reporter + pre-meeting-brief + going-cold-digest workers. Uses `definePluginEntry` from OpenClaw's internal plugin-entry module (auto-discovered across versions).

### Identity Cache (`lib/identity-cache.js`)
Loads 2,056 WhatsApp contacts from `~/.wacli/wacli.db` (SQLite via better-sqlite3) + 860 LID→phone mappings from `~/gowa/storages/history-*-INITIAL_BOOTSTRAP.json`. Provides `resolveJid("9191...@s.whatsapp.net") → "Ramon Berrios"`.

### Connector Registry (`lib/connector-registry.js`)
Scans `connectors/` for subdirs with `manifest.json` + `connector.js`, loads each, calls `isAvailable()`. Enabled connectors get `bootstrap()` run on first install (state in `~/.orbit/bootstrap.json`) then `poll()` on a schedule for batch connectors. Realtime connectors (WhatsApp, Slack) get webhook events routed via `handleRealtimeEvent()`.

### Connectors
| Connector | Mode | Interval | Source |
|---|---|---|---|
| whatsapp | realtime + bootstrap | events + 4s full-history scan | `~/gowa/storages/history-*-RECENT.json` |
| calendar | batch | 2h | `gws calendar events list --params '{...}'` |
| gmail | batch | 2h | `gws gmail users messages list/get` |
| linear | batch | 4h | GraphQL `api.linear.app/graphql` |
| slack | realtime | events | webhook → `processEvent` |

Each connector returns signals `{contactName, channel, timestamp, detail, isGroup?}`. The registry pushes them into the buffer.

### Signal Buffer (`lib/signal-buffer.js`)
- Dedups by `(participant, channel, day-bucket-from-signal-timestamp)`. Day-bucket not wall-clock — means historical bootstrap preserves per-day granularity.
- Flushes every 5s, up to 500 signals per batch, to `POST /api/v1/ingest`.
- Retry up to 3x on failure.
- Graceful shutdown flushes remaining on SIGTERM.

### Workers
- **Capability reporter**: introspects `~/.openclaw/openclaw.json` + env + CLI paths, POSTs `/api/v1/capabilities` every 30 min.
- **Pre-meeting brief**: every 5 min, checks next 30 min of calendar, pulls person cards via `/api/v1/persons/{id}`, composes brief via local OpenClaw gateway (`http://127.0.0.1:18789/v1/chat/completions`), delivers via `openclaw agent --deliver`.
- **Going-cold digest**: checks every 30 min, fires Monday 8am local if ≥1 contact is "going cold".

### Tools the agent can call
| Tool | Action |
|---|---|
| `orbit_lookup(query)` | Search contacts by name/company |
| `orbit_person_card(id)` | Full profile + interactions + shared connections |
| `orbit_going_cold(limit, days)` | High-score contacts not interacted with recently |
| `orbit_graph_stats()` | Totals: people, warm, going cold, interactions |
| `orbit_network_search(query)` | Who do I know at X? + intro paths |
| `orbit_status()` | Connector health |
| `orbit_ingest(interactions, persons?)` | Manual write path |
| `orbit_log_interaction(personId, channel, summary)` | Quick single interaction |

## Server architecture (`~/Documents/projects/personal/orbit/`)

Next.js 16 app on Vercel at `orbit-mu-roan.vercel.app`.

### Storage
- **Neo4j Aura** (instance `3397eac8`) — the graph itself. Person nodes + INTERACTED + KNOWS edges.
- **Supabase** (project `xrfcmjllsotkwxxkfamb`) — auth (email/password), profiles, api_keys (hashed).

### API surface (`src/app/api/`)
#### Public (agent or session auth)
- `POST /api/v1/ingest` — bulk write. Runs `filterIngestPayload` then `batchUpsertPersons` → `batchResolveParticipants` → `batchCreateInteractions` → `batchMergeKnows` via UNWIND queries in Neo4j. Returns counts.
- `POST /api/v1/capabilities` — plugin capability report. In-memory store per user (resets on cold start — acknowledged limitation).
- `GET /api/v1/capabilities` — web UI reads for checklist.
- `GET /api/v1/persons?q=&limit=&category=` — search.
- `GET /api/v1/persons/{id}` — full person card.
- `GET /api/v1/briefs?limit=&days=` — going-cold list.
- `GET /api/v1/graph` — stats only (different endpoint than dashboard's).
- `GET /api/v1/search?q=&limit=` — fuzzy match + shortestPath intro computation.
- `PATCH /api/v1/persons/{id}` — update metadata (company, category, title, email).
- `POST /api/v1/persons/{id}/interactions` — single interaction log.
- `POST /api/v1/edges` — create KNOWS edge.
- `POST /api/v1/reset` — wipe (session-only).

#### Dashboard-only (session auth)
- `GET /api/graph` — returns full nodes+links for constellation. **Different from `/api/v1/graph`** — this powers the UI.
- `GET /api/person/{id}` — person detail panel.
- `GET /api/search?q=` — quick text search.
- `POST /api/contacts` + `PUT /api/contacts` — manual add / CSV import.
- `POST /api/connectors/whatsapp` — WhatsApp export parser.
- `GET/POST/DELETE /api/keys` — API key management.

### Core libraries (`src/lib/`)
- **`scoring.ts`** — pure scoring engine (signal weights, channel boost, recency decay, normalization). Called by `/api/graph`.
- **`categories.ts`** — `normalizeCategory()` maps variants → valid set.
- **`ingest-filters.ts`** — `filterIngestPayload()` drops bots, newsletters, phone-number names.
- **`neo4j.ts`** — batch helpers with UNWIND queries, case-insensitive name matching.
- **`api-auth.ts`** — API key validation via Supabase RPC + in-memory rate limiting.

### Web pages (`src/app/`)
- `/` — landing
- `/login`, `/signup` — auth
- `/onboarding` — install-command UI + live agent checklist
- `/dashboard` — constellation + person panel + controls (Force/Score/Cluster/Fit)
- `/dashboard/settings` — integrations page
- `/test-graph` — internal dev page (can be removed)

## Data flow (write path, typical)

1. Wazowski's OpenClaw receives a WhatsApp message webhook
2. Plugin's `whatsapp/connector.js` → `processEvent(payload)` → spam filter → JID resolve → signal
3. `connector-registry.handleRealtimeEvent` → `signalBuffer.add(signal)`
4. Buffer dedups by `(participant|channel|day-bucket)`
5. Every 5s: `signalBuffer.flush()` → `POST /api/v1/ingest` with batch of ≤500 signals
6. Server: `filterIngestPayload` cleans → `batchUpsertPersons` creates/updates → `batchResolveParticipants` resolves names to IDs → `batchCreateInteractions` writes INTERACTED edges → `batchMergeKnows` writes cross-participant KNOWS
7. Neo4j stores

## Data flow (read path, dashboard)

1. User visits `/dashboard`
2. Server component checks Supabase session
3. `Dashboard` client calls `GET /api/graph`
4. Server queries Neo4j: person metadata + per-edge `{channel, timestamp}` + KNOWS counts
5. `scorePersonFromEdges()` computes live score (not stored)
6. Response: `{nodes, links, stats}`
7. `useGraphData` transforms → Reagraph renders constellation

## Onboarding flow

1. User signs up on `/signup`
2. Redirected to `/dashboard`, can visit `/onboarding`
3. Clicks "Generate install command" → `POST /api/keys` creates key → shown once
4. User pastes on agent machine: `openclaw plugins install orbit --marketplace kaldrex/orbit && openclaw env set ORBIT_API_KEY=<key>`
5. Plugin starts, POSTs `/api/v1/capabilities` — onboarding UI shows green dots for wired channels
6. User can see install succeeded; bootstrap runs in background
7. Within 10 min: dashboard populates

## What the agent does autonomously

- Cron: every 2h calendar/gmail poll, every 4h linear poll
- Cron: capability report every 30 min
- Cron: pre-meeting brief check every 5 min
- Cron: going-cold digest check every 30 min (fires Monday 8am local)
- Realtime: WhatsApp + Slack message events

## What requires a human

- Signup
- Running the install command once
- Consuming briefs/digests delivered to WhatsApp/Telegram
- Looking at the constellation on the web
