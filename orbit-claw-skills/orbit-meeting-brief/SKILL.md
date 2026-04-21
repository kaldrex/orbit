---
name: orbit-meeting-brief
description: Fetch upcoming Google Calendar events for the next N hours, synthesize a 100-word pre-meeting brief per event using Haiku 4.5 + attendee cards from Orbit, and POST the briefs back to Orbit's meetings endpoint.
metadata: {"openclaw":{"emoji":"📅"}}
---

# orbit-meeting-brief

## When to use

- Sanchay asks "what are my meetings today/tomorrow", "brief me on next 72h", "prep for my meetings".
- A daily cron/trigger wants to refresh the upcoming-meetings strip on Orbit's dashboard.
- Single run covers the next `horizon_hours` (default 72). No iterative polling — one run, one batch POST back.

## When NOT to use

- Past meetings — this skill is strictly future-looking. Past-meeting summaries are a separate future skill.
- Events without human attendees (just you, or just a room) — skip them; briefs are about *relationships*, not calendars.
- Bulk backfill of an entire year — not designed for that pattern.

## Safety

- Read-only against `gws calendar` + Orbit GET endpoints. The only write is the single batched `POST /api/v1/meetings/upcoming`.
- Never invoke `gws calendar events insert` / `update` / `delete`.
- Drop events whose attendees are all non-human (rooms, resources). Rooms have `resource: true` in the Google Calendar API; drop them.
- Drop events where you (`sanchaythalnerkar@gmail.com`) are the only attendee.
- Haiku calls are the ONLY LLM spend in this skill. Do not call Sonnet/Opus. Budget cap: 2048 input tokens per meeting (enforced via prompt caching + small context).
- Skip a meeting if a brief has been generated within the last 24h (the GET endpoint returns `generated_at`).

## Your tools

From `orbit-rules` plugin (call these as needed for attendee email canonicalization):
- `orbit_rules_canonicalize_email({email})` → `{canonical, domain, valid, original}`
- `orbit_rules_domain_class({domain, localpart_for_bot_check?})` → `{class, confidence, evidence}`

From `orbit-cli` plugin:
- `orbit_person_get({person_id})` → `{card}` — only useful if you already have a person_id.
- `orbit_persons_list_enriched()` → `{persons[]}` — paginated list of enriched persons. Each row has `emails[]`, so a single call gives you a local email→person_id map for the whole network.

HTTP (via the `bash` skill, using `curl`) — ONLY for the two meeting-layer endpoints the CLI plugin doesn't yet wrap:
- `GET $ORBIT_API_URL/meetings/upcoming?horizon_hours=72` — read current state (including `brief_md` + `generated_at`).
- `POST $ORBIT_API_URL/meetings/upcoming` — write the batch of briefs.

From `gws`:
- `gws calendar '+agenda' --days 3 --format json` — simple agenda for a quick scan.
- `gws calendar events list --params '{"calendarId":"primary","timeMin":"<iso>","timeMax":"<iso>","singleEvents":true,"orderBy":"startTime","maxResults":50}'` — full event payloads with `id`, `attendees`, `summary`, `start`, `end`. **This is the canonical source** — `+agenda` drops event IDs and attendees.

From the Anthropic SDK (via the built-in `anthropic` skill or direct `ANTHROPIC_API_KEY` bash curl):
- `claude-haiku-4-5` for synthesis. No thinking, no tool-use — plain completion with a cached system prompt.

## Order of operations

Given `horizon_hours` (default 72):

1. **Compute the time window.**
   - `TMIN = now UTC`, `TMAX = TMIN + horizon_hours`. ISO 8601 with offset.

2. **Fetch upcoming events from Google Calendar.**
   - Call `gws calendar events list --params '{"calendarId":"primary","timeMin":"<TMIN>","timeMax":"<TMAX>","singleEvents":true,"orderBy":"startTime","maxResults":50}'`.
   - The response has `.items[]`. Each item of interest has `id` (stable), `summary`, `start.dateTime`, `end.dateTime`, `attendees[]` (each with `email`, optional `displayName`, optional `self: true`, optional `resource: true`, optional `organizer: true`).
   - Filter out events with `status: "cancelled"`, zero attendees, or only `self` attendees.

3. **Read existing briefs from Orbit.**
   - `curl -sS -H "Authorization: Bearer $ORBIT_API_KEY" "$ORBIT_API_URL/meetings/upcoming?horizon_hours=<horizon>"`.
   - Build a `meetingId → {generated_at, has_brief}` map. If a meeting exists with `generated_at` within the last 24h AND `brief_md` is non-empty, SKIP that meeting — don't re-synthesize.

4. **Build the email→person lookup for attendees.**
   - Call `orbit_persons_list_enriched()` once. Flatten to `{emailLowercase → {person_id, card}}`.
   - For each attendee email not in the map, leave the person unresolved — the brief will fall back to "unknown contact" context for that attendee.

5. **For each meeting that needs a brief:**
   1. Collect the non-self attendee emails (drop `self: true`, drop any `resource: true`).
   2. For each remaining attendee: look up in the email→person map. If found, keep the person's `card`. If not, record `{email, name: displayName || email}`.
   3. Build a compact "attendee context" JSON: for each resolved person include only `{name, company, title, category, relationship_to_me, recent_topics, last_touch}` — NOT the full observation list. For unresolved attendees include `{email, name}` only.
   4. Call Haiku 4.5 with:
      ```
      System (cached):
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
   5. Record the brief text into your per-meeting envelope.

6. **POST the batch to Orbit.**
   - Build `{meetings: [{meeting_id, title, start_at, end_at, attendees: [{email, name?, person_id?}], brief_md?}, ...]}` with ONE entry per meeting you either (a) synthesized a brief for, or (b) found in gcal but the brief was fresh — in the (b) case, omit `brief_md` from the POST (the server preserves the existing one on partial upserts).
   - `curl -sS -X POST -H "Authorization: Bearer $ORBIT_API_KEY" -H "Content-Type: application/json" -d @<payload.json> "$ORBIT_API_URL/meetings/upcoming"`.
   - Expect `{upserted: N}` in response.

7. **Print the final log line.**
   - `meeting-brief horizon=<N>h events=<N> briefed=<N> skipped_fresh=<N> upserted=<N> cost_usd=<float>`

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

### Meeting entry POSTed to `/api/v1/meetings/upcoming`

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

- Drop events with `eventType: "outOfOffice"` (not meetings).
- Drop events missing `start.dateTime` (all-day events — separate UX).
- Drop attendees with emails matching a bot pattern (class=`bot` via `orbit_rules_domain_class`).
- If Haiku returns empty text or errors, log the failure per meeting, skip the brief but STILL upsert the meeting metadata (`brief_md` omitted). The strip will render the title + attendees without a brief.

## Final log line

```
meeting-brief horizon=<N>h events=<N_total> briefed=<N_new> skipped_fresh=<N_skip> upserted=<N> cost_usd=<usd> errors=<N_errors>
```

## Example run

Input: `Run orbit-meeting-brief skill once for 72h horizon.`

Expected output sequence:
1. One `gws calendar events list` call → 2 upcoming events.
2. One `GET /meetings/upcoming` call → 0 fresh briefs.
3. One `orbit_persons_list_enriched` call → ~1500 persons, email map built.
4. Two Haiku calls (one per meeting) with shared cached system prompt.
5. One `POST /meetings/upcoming` with 2 entries → `{upserted: 2}`.
6. Log: `meeting-brief horizon=72h events=2 briefed=2 skipped_fresh=0 upserted=2 cost_usd=0.002 errors=0`.

## When things fail

- `gws` offline / token expired → log it, exit with `events=0 upserted=0`. Don't fabricate.
- Orbit 401 → API key invalid. Log and exit; don't hammer with retries.
- Haiku rate-limit → surface the 429 in the per-meeting log; omit `brief_md` for that meeting; STILL upsert its metadata so the strip has the row.
- Partial success is fine — always upsert what you have.
