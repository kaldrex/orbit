# Intelligence Layer Redesign — Rules as Evidence for AI

**Status**: Brainstorming doc. Not implemented. Pick up in a future session.

**Core insight from Sanchay**: The rules shouldn't just filter noise and hand leftovers to AI. Rules should PRODUCE STRUCTURED EVIDENCE that makes the AI smarter. The AI then reads that evidence and maps relationships the way a human would — full graph topology, not just categories.

---

## The Problem with the Current Design

Current pipeline: `Raw Data → Rules (filter) → AI (classify leftovers)`

Rules and AI are two separate buckets. The rules say "this is spam, skip it" or "this has an @localhosthq.com email, mark as team." The AI gets the leftover 16% with no context about what the rules already figured out.

This means the AI is working blind. It sees "Umayr, 6626 WhatsApp messages" but doesn't know that the rules already determined:
- Umayr appears in 3 WhatsApp groups WITH Sanchay's team members
- Umayr's messages are 60% reciprocal (balanced conversation)
- Umayr's messaging pattern is daily, not bursty
- Umayr never appears in Calendar or Email (purely WhatsApp relationship)
- Umayr appears in the same groups as Pv, Imran, Meet (social cluster)

A human sitting down to map this would use ALL of that evidence. The AI should too.

---

## The Redesigned Pipeline

```
Raw Data → Rules (PRODUCE EVIDENCE) → Evidence Graph → AI (MAP RELATIONSHIPS using evidence)
```

### What rules produce (not just filter/pass)

Each rule doesn't just say "keep" or "skip." It produces a structured evidence object:

```json
{
  "contact": "Umayr",
  "evidence": [
    {
      "type": "messaging_pattern",
      "source": "whatsapp",
      "data": {
        "total_messages": 6626,
        "from_me": 3100,
        "from_them": 3526,
        "reciprocity_ratio": 0.88,
        "pattern": "daily",
        "avg_messages_per_day": 22,
        "active_since": "2026-01-15",
        "last_message": "2026-04-16"
      }
    },
    {
      "type": "group_copresence",
      "source": "whatsapp",
      "data": {
        "shared_groups": 3,
        "copresent_with": ["Pv", "Imran Sable", "Meet Kacha", "Aniruddha Pande"],
        "group_topics": ["friends hangout", "college batch"]
      }
    },
    {
      "type": "platform_absence",
      "data": {
        "present_in": ["whatsapp"],
        "absent_from": ["calendar", "gmail", "slack", "linear"],
        "inference": "personal relationship, not professional"
      }
    },
    {
      "type": "conversation_signals",
      "data": {
        "languages": ["english", "hindi"],
        "contains_media": true,
        "avg_message_length": 42,
        "emoji_usage": "high",
        "time_of_day": "evening/night (personal hours)"
      }
    }
  ]
}
```

### What AI does with evidence

The AI doesn't just assign a category. It builds the RELATIONSHIP MAP:

```json
{
  "contact": "Umayr",
  "category": "friend",
  "relationship_to_me": "Close personal friend. Daily WhatsApp conversations, mostly in evenings. Part of a close friend group with Pv, Imran, Meet, and Aniruddha. Purely personal — no work overlap (not in any Calendar, Email, Slack, or Linear).",
  "relationship_strength": "very_close",
  "relationship_type": "personal_friend",
  "connection_cluster": "college_friends",
  "knows": [
    {"name": "Pv", "evidence": "3 shared WhatsApp groups, both active daily", "strength": "strong"},
    {"name": "Imran Sable", "evidence": "2 shared groups, regular interaction", "strength": "moderate"},
    {"name": "Meet Kacha", "evidence": "1 shared group, both active", "strength": "moderate"}
  ]
}
```

This is what a human would produce if they sat down and mapped the relationships.

---

## Evidence Types the Rules Should Produce

### 1. Messaging Pattern Evidence

```
Rule input: WhatsApp DM message history
Rule output:
  - reciprocity_ratio (0-1, balanced = close relationship)
  - messaging_cadence (daily/weekly/sporadic/one-time)
  - avg_message_length (short = casual, long = substantive)
  - time_of_day_distribution (work hours = professional, evenings = personal)
  - first_contact_date, last_contact_date, active_duration
  - burst_detection (did they message intensely for 1 week then stop? or consistently?)
```

**Example — Umayr**:
- Reciprocity: 0.88 (very balanced — real friendship, not one-sided)
- Cadence: daily
- Time: 70% evening/night → personal
- Duration: 3 months continuous → established relationship
- AI inference: close personal friend

**Example — A recruiter**:
- Reciprocity: 0.1 (they send 90%, I reply 10%)
- Cadence: sporadic (3 bursts over 2 months)
- Time: 100% business hours → professional
- Duration: short bursts → transactional
- AI inference: recruiter/outreach, category = "other", low priority

### 2. Group Co-presence Evidence

```
Rule input: WhatsApp groups + members + activity
Rule output:
  - shared_groups with this contact
  - who else is in those groups (→ reveals social clusters)
  - activity level of both parties in each group
  - group topic/name (often reveals the context: "ETH Global", "Localhost Team", "Family")
```

**Example — Pv, Umayr, Imran, Meet, Aniruddha**:
All appear together in 2-3 groups. All active. Group names suggest college/friend context.
AI inference: this is a friend cluster. Create KNOWS edges between ALL of them with evidence "shared friend group, all actively messaging."

**Example — Chandan Perla + Hardeep Gambhir + Suhas Sumukh + Khushal Davesar**:
All appear in groups AND in Calendar meetings AND in Linear. Group names are work-related.
AI inference: this is the core team. KNOWS edges with "colleagues at LocalHost, daily collaboration."

### 3. Cross-Platform Presence/Absence Evidence

```
Rule input: which platforms a contact appears on
Rule output:
  - platforms_present: ["whatsapp", "calendar", "linear"]
  - platforms_absent: ["gmail", "slack"]
  - inference:
    - present in calendar + linear + whatsapp = team member or close collaborator
    - present only in whatsapp = personal contact
    - present only in calendar = external meeting (investor, partner, vendor)
    - present only in email = formal/transactional relationship
```

**Example — Ramon Berrios**:
- Calendar: 25 meetings (high frequency, recurring)
- WhatsApp: 3729 messages (active DM)
- Gmail: emails about invoices (Castmagic partnership)
- AI inference: close business partner, category = "founder", relationship = "co-building partner, weekly calls about Castmagic"

**Example — Ben Lang**:
- Calendar: 1 meeting
- No WhatsApp, no email, no Slack
- AI inference: one-time meeting, light connection, category = "fellow"

### 4. Calendar Pattern Evidence

```
Rule input: meeting history with a contact
Rule output:
  - meeting_count, meeting_frequency
  - is_recurring (daily standup vs ad-hoc)
  - meeting_size (1:1 = close, 3-4 = small group, 8+ = org-wide)
  - attendee_overlap (who else is always in these meetings?)
  - meeting_titles (reveal topics: "Board Meeting", "Product Review", "Catch-up")
```

**Example — Hardeep Gambhir**:
- Recurring daily meeting (collapsed to 1 signal)
- 1:1 meetings
- Also appears in team group meetings with Chandan, Suhas, Khushal
- AI inference: co-founder, daily collaboration, category = "team"

### 5. Email Pattern Evidence

```
Rule input: email thread history
Rule output:
  - thread_count, emails_per_thread
  - who_initiates (them vs me)
  - cc_network (who else is always CC'd → reveals business relationships)
  - subject_topics (invoices = vendor, pitch decks = investor, catch-up = friend)
  - reply_speed (fast = high priority, slow = low priority)
```

**Example — Skydo (Movin Jain)**:
- Multiple emails about invoices and recurring billing
- Always CC'd with finance-related subjects
- AI inference: vendor/service provider, category = "other", relationship = "Skydo account manager for international payments"

### 6. Identity Conflict Evidence

```
Rule input: canonical name resolver ambiguous matches
Rule output:
  - candidate_names: ["Ramon Berrios", "Ramon B", "ramongberrios"]
  - confidence: 0.75 (not sure if these are the same person)
  - evidence_for_merge: "same first name, email local part matches full name"
  - evidence_against_merge: "no shared phone or platform"
  - ask_ai: "Are 'Ramon Berrios' from Calendar and 'Ramon B' from WhatsApp the same person?"
```

The AI then makes the judgment call based on the full evidence, not just string similarity.

---

## How This Changes the Architecture

### Current:
```
Connector → Platform Rules (filter) → Signal Buffer → API
                                   ↘ Leftover → AI (classify)
```

### Redesigned:
```
Connector → Platform Rules (produce evidence) → Evidence Assembler
                                                       ↓
                                              Per-Contact Evidence Package
                                                       ↓
                                              AI Mapper (reads evidence, produces relationship map)
                                                       ↓
                                              Validated Relationship Graph → API
```

### The Evidence Assembler

New component. For each contact, it collects evidence from ALL rules across ALL platforms into one package:

```
Contact: "Umayr"
Evidence from WhatsApp rules:
  - messaging_pattern: daily, reciprocal, personal hours
  - group_copresence: shares 3 groups with friend cluster
Evidence from Calendar rules:
  - platform_absence: never appears in calendar (not professional)
Evidence from Gmail rules:
  - platform_absence: never appears in email
Evidence from Identity Resolver:
  - canonical_name: "Umayr" (no variants)
  - identifiers: phone only (no email)
```

This package goes to the AI. The AI reads it like a dossier and produces the relationship mapping.

### The AI Mapper

Not a simple classifier. It's a relationship analyst. For each contact, it:

1. Reads the evidence package
2. Determines category, relationship type, and strength
3. Identifies which OTHER contacts this person knows (from group co-presence, CC chains, shared meetings)
4. Writes `relationship_to_me` as a human would explain it
5. Identifies relationship CLUSTERS (friend group, work team, investor circle)

For the first-time ingestion, the AI Mapper processes contacts in cluster order — first the clusters it can identify from group/meeting co-presence, then the isolated contacts. This way, when it processes contact B, it already knows contact A's classification and can use that context.

---

## Examples of What the AI Mapper Would Produce

### Friend Cluster
```
AI input: Umayr, Pv, Imran Sable, Meet Kacha, Aniruddha Pande
  - All share 2-3 WhatsApp groups
  - All message daily in personal hours
  - None appear in Calendar/Email/Linear
  - High reciprocity across all

AI output:
  cluster_name: "Close Friends"
  members: [Umayr, Pv, Imran, Meet, Aniruddha]
  relationships:
    Umayr → friend, "Close personal friend, daily conversations"
    Pv → friend, "Part of core friend group, very active"
    Imran → friend, "Friend, regular group conversations"
    Meet → friend, "Friend from the same social circle"
    Aniruddha → friend, "Friend, shared group context"
  KNOWS edges: all pairwise with evidence "same friend group, daily interaction"
```

### Work Team Cluster
```
AI input: Hardeep, Chandan, Suhas, Khushal
  - All share WhatsApp groups + Calendar meetings + Linear issues
  - @localhosthq.com emails
  - Work-hours messaging, high frequency

AI output:
  cluster_name: "LocalHost Core Team"
  members: [Hardeep, Chandan, Suhas, Khushal]
  relationships:
    Hardeep → team, "Co-founder, daily standup, core collaborator"
    Chandan → team, "Team member, active on Linear issues"
    Suhas → team, "Team member, regular meetings"
    Khushal → team, "Operations lead, regular meetings"
  KNOWS edges: all pairwise with evidence "LocalHost team, daily collaboration"
```

### Business Partner (individual)
```
AI input: Ramon Berrios
  - Calendar: 25 meetings over 4 months (recurring weekly)
  - WhatsApp: 3729 messages, highly reciprocal
  - Email: invoice-related (Castmagic partnership)
  - Multi-platform: calendar + whatsapp + email = strong business relationship

AI output:
  Ramon Berrios → founder, Castmagic
  "Close business partner. Weekly calls, daily WhatsApp. Building together — invoice history suggests active business relationship. One of the strongest multi-platform connections."
  KNOWS: Martynas (co-appeared in 8 calendar meetings)
```

### One-time Meeting (individual)
```
AI input: Ben Lang
  - Calendar: 1 meeting at Anysphere
  - No WhatsApp, no email, no follow-up

AI output:
  Ben Lang → fellow, Anysphere (Cursor)
  "Met once. No ongoing relationship. Connection through the AI/dev tools space."
```

---

## What This Means for Implementation

1. **Platform rules need to be rewritten** to produce evidence objects, not just filter/pass decisions
2. **New component: Evidence Assembler** collects per-contact evidence packages
3. **AI Mapper replaces simple classifier** — reads evidence, produces full relationship topology
4. **Cluster detection** runs before AI mapping — groups contacts that appear together
5. **AI processes clusters, not individual contacts** — more context, better results
6. **First-time ingestion tells the user** "Setting up your relationship graph — carefully analyzing your communication history. This takes 10-15 minutes."

This is the design that makes Orbit as accurate as a human mapping relationships. The rules do the hard work of extracting evidence. The AI does the judgment work of interpreting it.

---

## Open Questions for Brainstorming Session

1. How much conversation content should we send to the AI? Full messages raise privacy concerns. Summaries lose context. Evidence objects are a middle ground — statistical patterns without raw text.

2. Should cluster detection be rules-based (group co-presence matrix) or AI-assisted? Rules can detect obvious clusters (shared groups), but AI might find hidden ones (two people who never share a group but are always mentioned together).

3. How do we handle the initial AI cost? 6 batch calls is cheap. But if evidence packages are rich, each call processes fewer contacts. Might be 20-30 calls for a thorough first-time analysis.

4. How do we update relationships over time? The first-time ingestion creates the map. But relationships change — a colleague becomes a friend, a partner goes cold. The decay engine handles scoring, but the AI should periodically re-evaluate relationship types too.

5. Should the AI Mapper produce KNOWS edges, or should those be purely evidence-based (rules)? Currently KNOWS edges come from co-presence. The AI might infer connections that co-presence doesn't show ("Ramon and Martynas know each other because they're both in the creator economy space, even though they only co-appeared in 8 calendar meetings").
