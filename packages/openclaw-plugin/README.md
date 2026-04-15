# @orbit/openclaw-plugin

Drop-in OpenClaw plugin that connects your agent to [Orbit](https://orbit-mu-roan.vercel.app) — the relationship intelligence platform.

## Setup

### 1. Get an API key

Sign up at Orbit, go to Dashboard > Settings, and generate an API key.

### 2. Set environment variable

```bash
export ORBIT_API_KEY=orb_live_your_key_here
```

### 3. Add to openclaw.json

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/path/to/orbit/packages/openclaw-plugin"
      ]
    },
    "allow": ["orbit-saas"]
  },
  "tools": {
    "alsoAllow": ["orbit-saas"]
  }
}
```

### 4. Copy the skill

Copy `SKILL.md` to `~/.openclaw/workspace/skills/orbit/SKILL.md` so your agent knows how to use the tools.

### 5. Restart your gateway

```bash
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
```

## Tools

| Tool | Type | Description |
|------|------|-------------|
| `orbit_lookup` | Read | Search contacts by name/company |
| `orbit_person_card` | Read | Full profile with interactions and connections |
| `orbit_going_cold` | Read | Contacts going cold (high score, no recent contact) |
| `orbit_graph_stats` | Read | Graph-level statistics |
| `orbit_ingest` | Write | Push observed interactions (bulk) |
| `orbit_log_interaction` | Write | Log a single interaction |

## How it works

Your agent observes conversations across all channels (Slack, WhatsApp, email, etc.). After each conversation, it calls `orbit_ingest` with the participants and a summary. Orbit builds the relationship graph automatically — creating people, logging interactions, scoring relationships, and discovering cross-connections.

When the user asks about someone, the agent calls `orbit_lookup` + `orbit_person_card` to get full context. For proactive intelligence, it checks `orbit_going_cold` and surfaces reconnect opportunities.
