# Orbit — Relationship Intelligence Plugin

Orbit tracks your professional relationships across WhatsApp, Calendar, Gmail, Slack, and Linear. It builds a scored relationship graph so you know who matters, who is fading, and what you last discussed.

## What happens automatically

The plugin runs connectors that capture interactions without any manual action:

- **WhatsApp** — processes messages in real-time via webhook. Every inbound/outbound message is scored and attributed to a resolved contact name.
- **Slack** — processes messages in real-time via webhook. Channel and DM activity is captured automatically.
- **Google Calendar** — polled every 2 hours. Meeting attendees are ingested as interactions.
- **Gmail** — polled every 2-4 hours. Email threads with resolved sender/recipient names are captured.
- **Linear** — polled every 2-4 hours. Issue assignments and comments are captured as interactions.

All connectors resolve identities automatically — WhatsApp JIDs, email addresses, and display names are mapped to the same person. Signals are deduplicated within a 5-minute window per person per channel, then flushed to the Orbit API every 30 seconds.

## When to use Orbit tools manually

Use these tools when the user asks about their relationships or contacts:

- **orbit_lookup** — search for a person by name. Use when asked "who is X?" or "find X".
- **orbit_person_card** — full profile with interaction history, relationship score, and last contact date. Use when asked for details about someone specific.
- **orbit_going_cold** — list contacts whose relationship scores are declining. Use when asked "who should I reach out to?" or "who am I losing touch with?".
- **orbit_graph_stats** — overview of the entire relationship graph (total contacts, active relationships, channel breakdown). Use for high-level summaries.

## When to call orbit_ingest manually

Call orbit_ingest only when you observe an interaction that no connector will capture:

- A conversation in a tool not covered by any connector (e.g. a phone call the user mentions, a meeting note from an unsupported platform).
- The user explicitly asks to record a relationship or interaction.
- Adding relationship_context metadata (e.g. "this person is my investor" or "met at YC W24 batch").

## Rules

- **Do not ingest duplicates.** The plugin handles all WhatsApp, Slack, Calendar, Gmail, and Linear signals. Never manually ingest something that flows through a connector.
- **Use resolved names, not identifiers.** Pass display names (e.g. "Rahul Sharma"), not phone numbers or JIDs. The identity cache resolves these upstream.
- **Add relationship_context when meaningful.** If the user mentions how they know someone, include it — "co-founder", "advisor", "former colleague at Stripe".
- **Respect the dedup window.** If you just saw a WhatsApp message from someone, don't also ingest it manually. The 5-minute dedup window handles bursts.
