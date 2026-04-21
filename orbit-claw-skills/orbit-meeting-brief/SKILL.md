---
name: orbit-meeting-brief
description: Fetch upcoming Google Calendar events for the next N hours, synthesize a 100-word pre-meeting brief per event using Haiku 4.5 + attendee cards from Orbit, and POST the briefs back to Orbit's meetings endpoint.
metadata: {"openclaw":{"emoji":"📅"}}
---

# orbit-meeting-brief

## When to use

- Sanchay asks "what are my meetings today/tomorrow", "brief me on next 72h", "prep for my meetings".
- A daily cron/trigger wants to refresh the upcoming-meetings strip on Orbit's dashboard.
- Single run covers the next `horizon_hours` (default 72). One run, one batch POST back.

## When NOT to use

- Past meetings — this skill is strictly future-looking.
- Events without human attendees (just you, or just a room) — briefs are about *relationships*, not calendars.
- Bulk backfill of an entire year — not designed for that pattern.

## Safety

- Read-only against `gws calendar` + Orbit GET endpoints. The only write is the single batched `POST /api/v1/meetings/upcoming` via `orbit_meeting_upsert`.
- Never invoke `gws calendar events insert` / `update` / `delete`.
- Drop events whose attendees are all non-human (rooms, resources). Rooms have `resource: true`.
- Drop events where you (`sanchaythalnerkar@gmail.com`) are the only attendee.
- Haiku calls are the ONLY LLM spend in this skill. Do not call Sonnet/Opus. Budget cap: 2048 input tokens per meeting (prompt caching + small context).
- Skip a meeting if a brief was generated within the last 24h (`orbit_meeting_list` returns `generated_at`).

## Your tools

This SKILL is four CLI verbs plus one LLM call. No raw HTTP, no hand-crafted `gws` argv — the plumbing is in `orbit-cli`.

From `orbit-cli` plugin:
- `orbit_calendar_fetch({horizon_hours})` → `{window, events[], count}` — shells out to `gws calendar events list` on claw and returns normalized events.
- `orbit_meeting_list({horizon_hours})` → `{meetings[]}` — reads existing briefs from Orbit.
- `orbit_person_get_by_email({email})` → `{person, found}` — resolves an attendee email to an Orbit card.
- `orbit_meeting_upsert({meetings:[...]})` → `{upserted:N}` — writes the batch of briefs.

From `orbit-rules` plugin (used when an attendee email needs bot-filtering before `orbit_person_get_by_email`):
- `orbit_rules_canonicalize_email({email})` → `{canonical, domain, valid, original}`
- `orbit_rules_domain_class({domain, localpart_for_bot_check?})` → `{class, confidence, evidence}`

From the Anthropic SDK (via the built-in `anthropic` skill):
- `claude-haiku-4-5` for synthesis. No thinking, no tool-use — plain completion with a cached system prompt.

## Order of operations (5 steps; 4 tools + 1 LLM)

```
1. orbit_calendar_fetch  --horizon_hours <N>          (tool)
2. orbit_meeting_list    --horizon_hours <N>          (tool)
3. for each unbriefed meeting:
     for each attendee.email:
       orbit_person_get_by_email <email>              (tool)
     gather { meeting, attendees_with_cards } as context
4. Haiku 4.5: "Write a ≤100-word brief …"             (SKILL — only LLM step)
5. orbit_meeting_upsert  --meetings [...]             (tool)
```

### Step detail

**1. Fetch upcoming events.**
Call `orbit_calendar_fetch({horizon_hours: 72})`. The tool composes `timeMin`/`timeMax`, invokes `gws calendar events list`, and returns `{window, events[], count}`. Each event has `id`, `summary`, `start.dateTime`, `end.dateTime`, `attendees[]`. Filter out:
- `status: "cancelled"`
- zero attendees or only `self: true`
- `eventType: "outOfOffice"`
- missing `start.dateTime` (all-day events)

**2. Read existing briefs.**
Call `orbit_meeting_list({horizon_hours: 72})`. Build `meetingId → {generated_at, brief_md}` map. Skip any meeting whose `generated_at` is within the last 24h AND has a non-empty `brief_md`.

**3. Resolve attendees.**
For each meeting that needs a brief, for each non-self attendee (drop `self: true`, `resource: true`, and any email whose domain classifies as `bot` via `orbit_rules_domain_class`): call `orbit_person_get_by_email({email})`.
- `{found: true, person}` → use the card's `{name, company, title, category, relationship_to_me}`.
- `{found: false}` → fall back to `{email, name: displayName || email}`.

Build a compact attendee-context JSON per meeting — see "Attendee context" below.

**4. Synthesize the brief (THE LLM STEP).**
One Haiku 4.5 call per meeting, with the shared cached system block and a minimal per-meeting user block:
```
System (cached, ephemeral):
  You write pre-meeting briefs for Sanchay, a founder. You are terse, specific, and never sycophantic.
  Given attendee context, produce a ≤100-word brief that:
    1. Names the shared history concretely (one to two past topics / interactions).
    2. Suggests ONE question Sanchay should raise in the meeting.
  Return ONLY the brief text — no preamble, no heading, no quotes, no markdown except bold/list where natural.
User:
  Meeting title: <summary>
  Starts at: <start.dateTime>
  Attendees:
    - <json block: attendee context>
  Write the brief.
```

**5. Upsert the batch.**
Build a `meetings[]` array (one entry per meeting — synthesized OR skipped-fresh; omit `brief_md` for skipped-fresh so the server preserves the existing one). Call `orbit_meeting_upsert({meetings: [...]})`. Expect `{upserted: N}`.

**6. Print the final log line.**
```
meeting-brief horizon=<N>h events=<N_total> briefed=<N_new> skipped_fresh=<N_skip> upserted=<N> cost_usd=<usd> errors=<N_errors>
```

## Prompt caching

Haiku 4.5 honors `cache_control: {type: "ephemeral"}` on the system block. The system prompt above is stable across every meeting — cache it so the first meeting pays the full prompt cost and every subsequent meeting pays the cache-hit rate (~10x cheaper input tokens).

## Envelope shapes

### Attendee context sent to Haiku

```json
{
  "name": "Umayr Sheik",
  "company": "SinX Solutions",
  "title": "Founder",
  "category": "team",
  "relationship_to_me": "Close friend and tech peer based in Dubai…",
  "recent_topics": ["ai", "fundraising", "movies"],
  "last_touch": "2026-04-16"
}
```

Or for unresolved attendees:
```json
{ "email": "new-contact@example.com", "name": "Alex J" }
```

### Meeting entry upserted via `orbit_meeting_upsert`

```json
{
  "meeting_id": "<gcal event id>",
  "title": "<event summary>",
  "start_at": "<ISO 8601 with offset>",
  "end_at":   "<ISO 8601 with offset | null>",
  "attendees": [
    { "email": "usheik@sinx.ai", "name": "Umayr Sheik", "person_id": "67050b91-5011-4ba6-b230-9a387879717a" }
  ],
  "brief_md": "<100-word text — omit when the existing brief is still fresh>"
}
```

## Budget

- Haiku input cost at V0: ~$1 / M tokens (cached) — ~2k tokens per meeting uncached, ~200 cached. At 5 meetings/day: ~$0.03/day.
- Output cost: 100-word brief ≈ 150 tokens × $5 / M = $0.00075 per meeting.
- **Projected cost / run / 5-meeting day: ~$0.005.** Cheap.

## Safety drops (enforce before emitting)

- Drop events with `eventType: "outOfOffice"`.
- Drop events missing `start.dateTime` (all-day events — separate UX).
- Drop attendees whose domain classifies as `bot` via `orbit_rules_domain_class`.
- If Haiku returns empty text or errors, log the failure per meeting, skip the brief but STILL include the meeting metadata in the upsert batch (`brief_md` omitted). The strip renders title + attendees without a brief.

## Final log line

```
meeting-brief horizon=<N>h events=<N_total> briefed=<N_new> skipped_fresh=<N_skip> upserted=<N> cost_usd=<usd> errors=<N_errors>
```

## Example run

Input: `Run orbit-meeting-brief skill once for 72h horizon.`

Expected call sequence (4 tools + 1 LLM + 1 upsert):
1. `orbit_calendar_fetch(horizon_hours=72)` → 2 upcoming events.
2. `orbit_meeting_list(horizon_hours=72)` → 0 fresh briefs.
3. `orbit_person_get_by_email(<email_1>)`, `orbit_person_get_by_email(<email_2>)` — per attendee across both meetings.
4. Two Haiku calls (one per meeting) with shared cached system prompt.
5. `orbit_meeting_upsert({meetings: [entry1, entry2]})` → `{upserted: 2}`.

Log: `meeting-brief horizon=72h events=2 briefed=2 skipped_fresh=0 upserted=2 cost_usd=0.002 errors=0`.

## When things fail

- `orbit_calendar_fetch` returns `{error:{code:"NETWORK_ERROR"}}` → gws offline / token expired. Log it, exit with `events=0 upserted=0`. Don't fabricate.
- `orbit_meeting_list` / `orbit_meeting_upsert` returns `{error:{code:"AUTH_FAILED"}}` → API key invalid. Log and exit; don't hammer with retries.
- Haiku rate-limit → surface the 429 in the per-meeting log; omit `brief_md` for that meeting; STILL upsert its metadata so the strip has the row.
- Partial success is fine — always upsert what you have.

## Ratio note (Phase 4.5)

This SKILL is 4 CLI-verb invocations + 1 Haiku call per meeting (the Haiku call is the *only* LLM step). The 60/40 tools-to-skills ratio holds: for a 2-meeting horizon you get 1 + 1 + 4 + 1 = 7 verb calls and 2 Haiku calls — 7:2, well past 60/40.
