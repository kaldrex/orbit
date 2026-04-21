---
name: orbit-enricher-delta
description: Scaled delta-bulk enricher. Picks persons with activity since last pass, fetches only the NEW messages since each person's last snapshot, batches 30 per ONE Haiku 4.5 call, and writes kind:"person" observations plus pass_kind:"enricher" snapshots. CLI does all the hard work (filter, batch, fetch, write). Haiku does the smart work (category + relationship_to_me + diff_summary + confidence_delta). Runs daily via cron OR on-demand via Telegram DM ("enrich today" / "enrich this week" / "enrich everyone").
metadata: {"openclaw":{"emoji":"🔄"}}
---

# orbit-enricher-delta

## When to use

- Daily pg_cron tick (3 AM UTC) — catch up on people with activity since yesterday.
- Sanchay DMs "enrich today" / "enrich this week" / "enrich everyone I talked to recently".
- Called with `scope: "persons", person_ids: [...]` for a specific list.

## When NOT to use

- For a clean-slate bulk enrichment of everyone with `category='other'` — that's `orbit-enricher` (the existing skill). `delta` only considers people with recent activity and compares against their PREVIOUS snapshot.
- For one-off manual single-person enrichment — just DM Wazowski with the person's id, both SKILLs support it but `orbit-enricher-delta` scales better.

## Safety

- ONE Haiku 4.5 call per batch of 30 persons. Model: `claude-haiku-4-5` (hardcoded).
- Never touches Umayr (`67050b91-5011-4ba6-b230-9a387879717a`) or Ramon (`9e7c0448-dd3b-437c-9cda-c512dbc5764b`) — canaries.
- Every write goes through orbit-cli (no raw HTTP, no DB bypass).
- Skips persons with delta=0 messages (nothing new to say about them).
- Budget ceiling: $5/invocation. Abort if exceeded.

## Your tools

From `orbit-cli`:
- `orbit_persons_active_since({since, needs_enrichment?})` → `{persons:[{person_id, last_activity_at, activity_count}], total}` — **the selector**. Pure Postgres.
- `orbit_person_get({person_id})` → `{card: {...}}` — **current card state**.
- `orbit_person_snapshots_list({person_id, limit: 1})` → `{snapshots: [{pass_at, pass_kind, card_state}]}` — **watermark reader** (latest snapshot of any kind).
- `orbit_messages_fetch({person_id, since, limit})` → `{messages:[{ts, body, ctx, from_me}], count}` — **delta fetcher** (new `since` param fetches only messages after that timestamp).
- `orbit_observation_bulk({file_path})` → `{total_inserted, ...}` — **observations writer**.
- `orbit_person_snapshot_write({person_id, pass_kind, card_state, evidence_pointer_ids, diff_summary, confidence_delta})` → `{ok, id}` — **snapshot writer**.

From Anthropic SDK:
- `claude-haiku-4-5` — the ONE LLM call per batch. Hardcoded. Do NOT substitute.

## Scope parameter

Caller passes ONE of:
- `scope: "active_since", since: "<ISO 8601>"` — picks candidates via `orbit_persons_active_since`. Default for daily cron.
- `scope: "persons", person_ids: ["<uuid>", ...]` — explicit list (on-demand DM, debugging).
- `scope: "active_since_days_ago", days: 1` — convenience: compute since from `now() - N days`.

## Order of operations

```
1. Select candidates (CLI)
   - scope=active_since       → orbit_persons_active_since(since)
   - scope=active_since_days_ago → compute since = now - days * 86400, then same
   - scope=persons            → use the given person_ids directly
   Drop Umayr + Ramon from any list before proceeding.

2. For each candidate, build a batch entry (CLI):
   a. orbit_person_get({person_id}) → card
   b. orbit_person_snapshots_list({person_id, limit: 1}) → last_snapshot (may be absent)
   c. delta_since = last_snapshot?.pass_at OR (last_snapshot absent → null, treat all msgs as new)
   d. orbit_messages_fetch({person_id, since: delta_since, limit: 30}) → messages
   e. IF messages.count == 0 AND last_snapshot exists → skip this person (nothing new, no Haiku call needed)
   Append {person_id, name, phones, emails, prev_state: last_snapshot?.card_state ?? card, new_messages} to batch.

3. Chunk batch into groups of 30. For each chunk:
   ONE Haiku 4.5 call with the prompt below.

4. Parse the response. For each result:
   a. Build a kind:"person" observation envelope (evidence_pointer "enrichment://delta-enricher-<date>/person-<id>") → append to NDJSON file.
   b. Build the snapshot payload (card_state, diff_summary, confidence_delta).

5. orbit_observation_bulk({file_path}) → flush observations.

6. For each person in this chunk's results:
   orbit_person_snapshot_write({person_id, pass_kind: "enricher", card_state, evidence_pointer_ids, diff_summary, confidence_delta}).
```

## The Haiku 4.5 prompt

**System (cached):**
```
You are Orbit's delta-pass enricher. For each person you receive (a) their previous card state and (b) NEW messages that arrived since the last pass, output whether anything meaningful has changed.

Rules:
- verdict = "changed" if category or relationship_to_me meaningfully shifted; "reinforced" if confirmed same direction; "no_signal" if new messages are noise (OTPs, receipts).
- category: investor | team | founder | friend | community | media | sponsor | fellow | other
- relationship_to_me: 1-2 sentences, cite specific signal from new messages.
- diff_summary: ONE founder-readable sentence — what shifted OR what was reinforced. This becomes the headline of the Evolution row. Examples: "Continued DSA thread; no shift." / "New work context (Google Meet + task ownership) raises conviction on co-lead framing." / "Two OTPs only; no meaningful signal."
- confidence_delta: per-field float in [-1, +1]. Positive = signal strengthens the claim, negative = weakens. 0 = no change.
- If prev_state.category was "other" and we now have signal, upgrade — do not default to "other".

Output JSON only, no preamble:
{
  "results": [
    { "person_id": "<echo>", "verdict": "changed|reinforced|no_signal",
      "category": "<enum>", "relationship_to_me": "<1-2 sentences>",
      "diff_summary": "<1 sentence>",
      "confidence_delta": { "category": <float>, "relationship_to_me": <float> }
    },
    ...
  ]
}
```

**User (per batch call):**
```
Batch of <N> persons. For each, classify based on the new messages vs their previous state.

[
  {
    "person_id": "<uuid>",
    "name": "<name>",
    "phones": [...],
    "emails": [...],
    "prev_state": {
      "category": "<prev>",
      "relationship_to_me": "<prev>",
      "company": "<prev or null>",
      "title": "<prev or null>"
    },
    "new_messages": [
      {"ts": "<iso>", "from_me": <bool>, "body": "<first 200 chars>"},
      ...
    ]
  },
  ...
]

Return the JSON.
```

Truncate each message body to 200 chars. Cap each person's new_messages at 30 (most recent).

## Observation envelope (per result)

```json
{
  "observed_at": "<now ISO>",
  "observer": "wazowski",
  "kind": "person",
  "evidence_pointer": "enrichment://delta-enricher-<YYYY-MM-DD>/person-<person_id>",
  "confidence": 0.8,
  "reasoning": "Delta enricher: <result.diff_summary>",
  "payload": {
    "name": "<card.name — do NOT change>",
    "company": "<prev.company unchanged unless result says otherwise>",
    "category": "<result.category>",
    "title": "<prev.title unchanged unless result says otherwise>",
    "relationship_to_me": "<result.relationship_to_me>",
    "phones": <card.phones>,
    "emails": <card.emails>
  }
}
```

## Snapshot payload (per result)

```json
{
  "person_id": "<id>",
  "pass_kind": "enricher",
  "card_state": {
    "name": "<card.name>",
    "category": "<result.category>",
    "relationship_to_me": "<result.relationship_to_me>",
    "company": "<...>",
    "title": "<...>"
  },
  "evidence_pointer_ids": [],
  "diff_summary": "<result.diff_summary>",
  "confidence_delta": <result.confidence_delta>
}
```

## Final summary

Return:
```json
{
  "ok": true,
  "status": "succeeded",
  "scope": "<echo>",
  "candidates": <N>,
  "enriched": <M>,
  "skipped_no_delta": <X>,
  "skipped_canary": <Y>,
  "observations_inserted": <M>,
  "snapshots_written": <M>,
  "category_shift": {"<cat>": <count>, ...},
  "verdicts": {"changed": <n>, "reinforced": <n>, "no_signal": <n>},
  "cost_usd": <approx>
}
```

## Hard rules

- **Haiku 4.5** model. No Sonnet, no Opus.
- **30 per batch.** ONE Haiku call per 30. Never loop per-person.
- **Skip canaries.** Always.
- **Skip delta=0 persons.** Don't burn tokens on no-signal.
- **Never mutate identity** (name, phones, emails). Enricher is interpretation only.
- **Evidence pointer format** `enrichment://delta-enricher-<DATE>/person-<id>` — dedupes on same day.
