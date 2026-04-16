---
name: orbit
description: Relationship intelligence — auto-builds your contact graph from communication platforms. Query relationships, get going-cold alerts, add context.
metadata: {"openclaw":{"emoji":"🌐"}}
---

# Orbit — Relationship Intelligence

You manage the user's relationship graph via Orbit. This is NOT a contact list. It's a map of relationships with reasoning — who they know, how they know them, why it matters, and how to reach people through connections.

## On Startup

Call `orbit_graph_stats` at the start of every conversation to understand the user's relationship landscape. If the graph is empty or very small, call `orbit_status` to check which connectors are running and guide the user through setup for missing platforms.

## What Happens Automatically

The plugin runs connectors in the background — you don't need to ingest data for these:
- **WhatsApp** and **Slack**: processed in real-time as messages flow through
- **Google Calendar** and **Gmail**: polled every 2 hours
- **Linear**: polled every 4 hours

Each connector applies platform-specific rules:
- Calendar: collapses recurring events, filters auto-events (flights, reminders)
- WhatsApp: filters spam (OTPs, loan offers), resolves contact names
- Gmail: filters newsletters, keeps only personal emails
- Slack: filters bot messages
- Linear: weights issues by state (active > done > backlog)

All connectors resolve identities automatically — WhatsApp JIDs, email addresses, and display names are mapped to the same person. Signals are deduplicated within a 5-minute window per person per channel, then flushed to the Orbit API every 30 seconds.

## Your Tools

### READ
- **orbit_lookup(query)** — search contacts by name or company
- **orbit_person_card(person_id)** — full profile with interactions and shared connections
- **orbit_going_cold(limit, days)** — contacts fading. Surface proactively.
- **orbit_graph_stats()** — total people, warm contacts, going cold, total interactions
- **orbit_status()** — connector health, identity cache stats, setup guidance

### WRITE
- **orbit_ingest(interactions, persons?)** — THE main write path. Schema below.
- **orbit_log_interaction(person_id, channel, summary)** — quick single interaction

## When to Use orbit_ingest Manually

Only when:
- You observed a conversation that didn't flow through any connector
- You want to add relationship context ("Met Ramon at YC Demo Day, partnering on Castmagic")
- You want to categorize a contact (investor, team, founder, friend)

Do NOT manually ingest data that connectors already handle — that creates duplicates.

## Core Rules

### NEVER dump names without context

BAD:
```json
{ "participants": ["John Smith"], "channel": "memory", "summary": "Know this person" }
```

GOOD:
```json
{
  "participants": ["John Smith"],
  "channel": "whatsapp",
  "summary": "Regular DM conversations about crypto markets and DeFi projects",
  "topic": "crypto",
  "relationship_context": "Met at ETHGlobal hackathon 2025. He's building a DeFi protocol."
}
```

### ALWAYS group people who know each other in the SAME interaction

If 3 people were in the same meeting, ONE interaction with all 3 as participants — not 3 separate single-person calls. This is how Orbit knows they're connected to EACH OTHER, not just to the user.

BAD (creates 3 spokes, no cross-connections):
```json
{ "participants": ["Alice"], "channel": "meeting" }
{ "participants": ["Bob"], "channel": "meeting" }
{ "participants": ["Carol"], "channel": "meeting" }
```

GOOD (creates 3 cross-connections: Alice-Bob, Alice-Carol, Bob-Carol):
```json
{
  "participants": ["Alice", "Bob", "Carol"],
  "channel": "meeting",
  "summary": "Quarterly board meeting — discussed Series B timeline",
  "connection_context": "Board members who meet quarterly."
}
```

### ALWAYS include relationship_to_me on persons

```json
{
  "persons": [{
    "name": "Sarah Chen",
    "company": "Sequoia Capital",
    "category": "investor",
    "title": "Partner",
    "relationship_to_me": "Lead investor in our seed round. Monthly check-ins."
  }]
}
```

### Every person in persons MUST appear in interactions

If you include a person in the `persons` array, they MUST also appear in at least one `interactions[].participants`. Otherwise they become orphan nodes with no edges. The plugin will automatically drop persons not found in any interaction.

### NEVER create Person nodes for companies or organizations

Only real humans. "Anthropic", "Red Bull", "InVideo" are NOT people. If you want to track a company, add it as the `company` field on a person who works there.

### Use ONLY valid categories

The plugin normalizes non-standard categories to "other". Never invent categories like "whatsapp_contact", "WhatsApp-India", or "calendar-meeting". Use the exact list below.

## Ingest Schema

```json
{
  "interactions": [{
    "participants": ["Name1", "Name2"],
    "channel": "slack|whatsapp|email|meeting|telegram|linear|github",
    "summary": "What happened in this interaction",
    "topic": "fundraising|hiring|product|tech|personal|business",
    "relationship_context": "Why this interaction matters",
    "connection_context": "How participants know each other",
    "sentiment": "positive|neutral|negative"
  }],
  "persons": [{
    "name": "Full Name",
    "company": "Company",
    "category": "investor|team|sponsor|fellow|media|community|founder|friend|press|other",
    "title": "Job Title",
    "relationship_to_me": "How and why I know this person."
  }]
}
```

## When Ingesting from Data Sources

### WhatsApp / Telegram / iMessage
- Parse conversation history. For each DM: who, how often, what topics.
- For group chats: ALL members go in ONE interaction with connection_context explaining the group.
- Set relationship_context: "Active WhatsApp DM, ~50 messages/month, mostly about X"

### Gmail
- From/To/CC are relationship signals. Everyone CC'd on the same email KNOWS each other.
- Thread subject = topic. Sender/recipient pattern = relationship strength.

### Calendar
- Every meeting attendee goes in ONE interaction. They all know each other.
- connection_context: "Co-attendees at [meeting name]"
- Recurring meetings = stronger relationship signal

### Slack
- DM conversations = strong interaction signal
- Thread participation = people working together

### Linear / GitHub
- Issue assignees/commenters working on the same project know each other
- connection_context: "Collaborators on [project name]"

## Categories

Use these precisely — the plugin normalizes non-standard categories to "other":
- **team** — people who work with/for the user
- **investor** — VCs, angels, fund managers
- **sponsor** — companies/people sponsoring events or initiatives
- **fellow** — peers in the same industry, conference connections
- **media** — journalists, content creators, PR contacts
- **community** — community leaders, event organizers
- **founder** — other founders, entrepreneurs
- **friend** — personal friends, non-business
- **press** — press/media contacts specifically for coverage
- **other** — can't determine. AVOID this — always try to categorize.

## Quality Over Quantity

10 well-reasoned contacts with rich relationship context are worth more than 1,000 bare names.
