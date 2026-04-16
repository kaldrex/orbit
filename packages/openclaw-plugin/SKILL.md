---
name: orbit
description: Relationship intelligence — build and query the user's relationship graph. Every contact needs context. Every connection needs reasoning.
metadata: {"openclaw":{"emoji":"🌐"}}
---

# Orbit — Relationship Intelligence

You manage the user's relationship graph via Orbit. This is NOT a contact list. It's a map of relationships with reasoning — who they know, how they know them, why it matters, and how to reach people through connections.

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
  "relationship_context": "Met at ETHGlobal hackathon 2025. He's building a DeFi protocol. Good technical contact for web3 questions."
}
```

### ALWAYS group people who know each other in the SAME interaction

If 3 people were in the same meeting, ONE interaction with all 3 as participants — not 3 separate single-person calls. This is how Orbit knows they're connected to EACH OTHER, not just to you.

BAD (creates 3 spokes, no cross-connections):
```json
{ "participants": ["Alice"], "channel": "meeting" }
{ "participants": ["Bob"], "channel": "meeting" }
{ "participants": ["Carol"], "channel": "meeting" }
```

GOOD (creates 3 cross-connections: Alice↔Bob, Alice↔Carol, Bob↔Carol):
```json
{
  "participants": ["Alice", "Bob", "Carol"],
  "channel": "meeting",
  "summary": "Quarterly board meeting — discussed Series B timeline and hiring plan",
  "topic": "fundraising",
  "connection_context": "Board members who meet quarterly. Alice leads the round, Bob is existing investor, Carol is independent director."
}
```

### ALWAYS include relationship_to_me on persons

When you add metadata about a person, explain the relationship:

```json
{
  "persons": [{
    "name": "Sarah Chen",
    "company": "Sequoia Capital",
    "category": "investor",
    "title": "Partner",
    "relationship_to_me": "Lead investor in our seed round. Monthly check-ins. Go-to for fundraising advice and intro requests."
  }]
}
```

## Your Tools

### READ
- **orbit_lookup(query)** — search by name/company
- **orbit_person_card(person_id)** — full profile with interactions and connections
- **orbit_going_cold(limit, days)** — contacts fading. Surface proactively.
- **orbit_graph_stats()** — totals

### WRITE
- **orbit_ingest(interactions, persons?)** — THE main write path. Schema below.
- **orbit_log_interaction(person_id, channel, summary)** — quick single interaction

## Ingest Schema

```json
{
  "interactions": [{
    "participants": ["Name1", "Name2"],       // REQUIRED. Group co-participants together.
    "channel": "slack|whatsapp|email|meeting|telegram|linear|github",
    "summary": "What happened in this interaction",
    "topic": "fundraising|hiring|product|tech|personal|business",
    "relationship_context": "Why this interaction matters for the relationship",
    "connection_context": "How the participants know each other (for KNOWS edges)",
    "sentiment": "positive|neutral|negative"
  }],
  "persons": [{
    "name": "Full Name",
    "company": "Company",
    "category": "investor|team|sponsor|fellow|media|community|founder|friend|press|other",
    "title": "Job Title",
    "relationship_to_me": "How and why I know this person. What value does this relationship have."
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
- Set relationship_context: "Regular email correspondent, typically about X"

### Calendar
- Every meeting attendee goes in ONE interaction. They all know each other.
- connection_context: "Co-attendees at [meeting name]"
- Recurring meetings = stronger relationship signal

### Slack
- Channel membership = weak KNOWS signal
- DM conversations = strong interaction signal
- Thread participation = people working together

### Linear / GitHub
- Issue assignees/commenters working on the same project know each other
- connection_context: "Collaborators on [project name]"

## Categories

Use these precisely:
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

10 well-reasoned contacts with rich relationship context are worth more than 1,000 bare names. When you're not sure about the relationship, say so in the context rather than leaving it blank.
