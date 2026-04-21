---
name: orbit-enricher-delta-smoke
description: READ-ONLY smoke test for the delta-bulk enrichment design. Given one person_id, fetches their current card + latest snapshot + recent WhatsApp messages, assembles a "previous state + new signal since last pass" prompt, makes ONE Haiku 4.5 call, and returns the classification output VERBATIM. Writes nothing. Used to validate the prompt + output shape before the production write-path SKILL is built.
metadata: {"openclaw":{"emoji":"🧪"}}
---

# orbit-enricher-delta-smoke

## When to use

- Smoke testing the delta-bulk enrichment design before the production verbs + SKILL land.
- Studying Haiku 4.5's output quality on a small number of real people (1–3 per run).
- Validating that "previous state + new signal → diff_summary + confidence_delta" produces useful output.

## When NOT to use

- This is NOT production. It writes nothing. Do not use it to update cards.
- Do NOT run on Umayr (`67050b91-5011-4ba6-b230-9a387879717a`) — he's the canary.

## Safety

- **READ-ONLY.** No `orbit_observation_emit`, no `orbit_observation_bulk`, no `orbit_person_snapshot_write`. Zero writes to Orbit.
- ONE Haiku 4.5 call per invocation. Model: `claude-haiku-4-5` (hardcoded). Cost: ~$0.002 per person.

## Your tools

From `orbit-cli`:
- `orbit_person_get({person_id})` → `{card: {name, category, relationship_to_me, phones[], emails[], ...}}` — current card state.
- `orbit_person_snapshots_list({person_id, limit: 1})` → `{snapshots: [{pass_at, pass_kind, card_state, diff_summary}]}` — latest snapshot (if any).
- `orbit_messages_fetch({person_id, limit: 50})` → `{messages: [{ts, body, ctx, from_me?}], count}` — last 50 WhatsApp messages.

From the Anthropic SDK:
- `claude-haiku-4-5` — the ONE LLM call. Do not substitute.

## Order of operations

```
1. orbit_person_get(person_id)              → card
2. orbit_person_snapshots_list(person_id, 1) → prior snapshot (or none)
3. orbit_messages_fetch(person_id, 50)      → recent messages
4. Compute the delta window:
     - If a snapshot exists, delta_since = snapshot.pass_at (ISO)
     - If no snapshot, delta_since = null → treat all 50 messages as "new signal"
   Filter `messages` to those with ts (ms) >= delta_since (if set).
5. ONE Haiku 4.5 call with the prompt below.
6. Return the parsed JSON output verbatim. DO NOT write anything anywhere.
```

## The Haiku 4.5 prompt

**System:**
```
You are Orbit's delta-pass enricher. A "pass" is a periodic re-classification of a person using ONLY the new signal since the last time we looked. You get: (a) the previous card state (what we thought last time), (b) the messages that arrived since then. Your job is to say whether anything meaningful has changed, and if so, what.

Output JSON only, no preamble:
{
  "person_id": "<echo>",
  "category": "<enum: investor|team|founder|friend|community|media|sponsor|fellow|other>",
  "relationship_to_me": "<1-2 sentences, specific — cite actual signals from the messages>",
  "diff_summary": "<ONE sentence in founder-readable English: what changed this pass OR what's reinforced if nothing changed. E.g. 'Continued DSA thread; no category shift.' or 'New work context (Google Meet + task ownership) suggests co-lead relationship rather than pure friend.'>",
  "confidence_delta": {"category": <-1..+1 float>, "relationship_to_me": <-1..+1 float>},
  "verdict": "changed" | "reinforced" | "no_signal"
}

Rules:
- "verdict": "changed" if category or relationship_to_me meaningfully shifted from prev_state. "reinforced" if same direction confirmed. "no_signal" if new messages are empty/noise (OTPs, receipts).
- "diff_summary" is the founder-readable headline of the row that lands in the Evolution stack. Keep it specific and short.
- confidence_delta uses positive floats when signal strengthens a claim, negative when it weakens. 0 if no change.
- Never invent facts not present in messages. If uncertain, lean toward "reinforced" over "changed".
```

**User (per call):**
```
Person: <card.name>  (id=<person_id>)
Phones: <card.phones>
Emails: <card.emails>

Previous state (from last snapshot at <delta_since or "no prior snapshot">):
  category: <card_state.category>
  relationship_to_me: <card_state.relationship_to_me>
  company: <card_state.company | null>
  title: <card_state.title | null>

New signal since last pass (<N> messages):
  [ { "ts": "<iso>", "from_me": <bool>, "body": "<first 200 chars>" }, … ]

Classify and output the JSON.
```

Truncate each message body to 200 characters. If > 30 messages in the delta, pass only the 30 most recent.

## Output

Return ONLY the parsed JSON from the Haiku response. No summary, no explanation, no commentary. The caller is studying the output shape and content — they don't need you to editorialize.

If Haiku returns malformed JSON, report the raw response verbatim with a note "LLM_PARSE_ERROR" and the first 500 chars of the response.

## Hard rules

- **READ-ONLY.** Do not call `orbit_observation_emit`, `orbit_observation_bulk`, `orbit_person_snapshot_write`, or any other write verb.
- **Haiku 4.5.** Do not substitute Sonnet, Opus, or any other model.
- **One person per invocation.** The production SKILL will batch 30 — this smoke version tests one at a time for clarity.
- **Never skip the canary** — if `person_id` is Umayr (`67050b91-...`), refuse with `{"error": "canary_protected"}`.
