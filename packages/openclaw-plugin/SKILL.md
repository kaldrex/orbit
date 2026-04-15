---
name: orbit
description: Relationship intelligence — search contacts, get briefs, push observed interactions to the graph. Use orbit tools for anything about people, relationships, or networking.
metadata: {"openclaw":{"emoji":"🌐"}}
---

# Orbit — Relationship Intelligence

You have access to your user's relationship graph via the Orbit plugin. Use it whenever:
- Someone asks about a person, contact, or relationship
- You observe a conversation and want to record who was involved
- You need to find warm intro paths or going-cold contacts
- You're preparing for a meeting and need background on attendees

## Your Tools

### READ (use freely, no side effects)

- **orbit_lookup(query)** — search contacts by name or company. Start here.
- **orbit_person_card(person_id)** — full profile: score, interactions, shared connections. Use after lookup.
- **orbit_going_cold(limit, days)** — contacts going cold. Surface proactively in morning messages.
- **orbit_graph_stats()** — total contacts, warm count, going cold count.

### WRITE (updates the graph)

- **orbit_ingest(interactions, persons?)** — THE MAIN WRITE PATH. After you observe any conversation, push it here. Include all participants, the channel, a summary, and the topic. Orbit auto-creates people, logs interactions, and builds cross-connections.
- **orbit_log_interaction(person_id, channel, summary)** — log a single interaction. Use for quick DM exchanges.

## When to Write

**Push to orbit_ingest after you observe:**
- A Slack DM or thread with named participants
- An email you read or sent
- A calendar meeting that happened
- A WhatsApp/Telegram/iMessage conversation
- Any interaction where you can identify who was involved

**Format for ingest:**
```json
{
  "interactions": [{
    "participants": ["Jane Smith", "Bob Chen"],
    "channel": "slack",
    "summary": "Discussed Series B timeline",
    "topic": "fundraising"
  }],
  "persons": [{
    "name": "Jane Smith",
    "company": "Sequoia",
    "category": "investor",
    "title": "Partner"
  }]
}
```

Include `persons` metadata when you know it. Orbit will auto-create unknown people and update existing ones.

## When to Read

- "Who's [name]?" → `orbit_lookup` → `orbit_person_card`
- "Brief me" / "What's my day?" → `orbit_going_cold` + any meeting context you have
- "How do I reach [person]?" → `orbit_lookup` → check shared connections in person card
- "Who's going cold?" → `orbit_going_cold`
- "How many contacts do I have?" → `orbit_graph_stats`

## Categories

Contacts are categorized: investor, sponsor, media, team, fellow, community, gov, founder, friend, press, other. When you ingest a new person, set the category if you can infer it. If unsure, leave it as "other" — the user can recategorize later.

## Important

- Person IDs look like `p_abc123` — get them from orbit_lookup results
- The graph updates in real-time — after ingest, lookup will show the new data
- Relationship scores auto-increment on each interaction (max 10)
- Going cold = score > 5 AND no interaction in 14+ days
