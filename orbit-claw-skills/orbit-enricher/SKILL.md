---
name: orbit-enricher
description: Bulk-enrich skeleton person cards (category='other') in Orbit. Lists up to 30 skeletons, fetches recent WhatsApp context per person, classifies them in ONE Claude Sonnet 4 call, emits kind:"person" observations via orbit_observation_bulk, then writes one person_snapshot per enriched person so the UI Evolution stack can show what this pass learned.
metadata: {"openclaw":{"emoji":"🪶"}}
---

# orbit-enricher

## When to use

- A scheduled job (or Sanchay directly) asks you to enrich persons currently stuck in `category: "other"`.
- Single batch run: up to 30 persons per invocation. One LLM call classifies the whole batch.
- This is the sibling to `orbit-observer`. Observer CREATES persons from a seed; enricher UPGRADES existing skeleton cards in bulk.

## When NOT to use

- Do NOT create new persons — that's the observer's job.
- Do NOT re-enrich persons whose latest card already has a non-`other` category — they're done.
- Do NOT emit `kind: "interaction"`, `kind: "merge"`, `kind: "correction"` — enricher is strictly `kind: "person"`.
- Do NOT use for Slack / Linear / Calendar — V0 is WhatsApp + Gmail only.
- Do NOT touch Umayr (`67050b91-5011-4ba6-b230-9a387879717a`) or Ramon (`9e7c0448-dd3b-437c-9cda-c512dbc5764b`). Skip them — they're canaries.

## Safety

- Read-only against WhatsApp via `orbit_messages_fetch`. Never send messages.
- Every write to Orbit goes through `orbit_observation_bulk`. Never raw HTTP, never direct DB.
- Drop persons with zero recent messages — no signal to enrich from.
- ONE Claude call per batch. No per-person LLM calls. Model: `claude-sonnet-4-20250514`.
- Preserve identity: do NOT invent or mutate phones, emails, or the canonical name. Only emit interpretation fields (`category`, `relationship_to_me`, `company`, `title`).

## Your tools

From `orbit-cli` plugin (pure plumbing — no LLM):
- `orbit_persons_list_enriched({cursor?, limit?})` → `{persons: [{id, name?, phones[], emails[], category, relationship_to_me?, ...}]}` — paginated list; we iterate until we find 30 persons whose latest card has `category === "other"`.
- `orbit_messages_fetch({person_id, limit})` → `{person_id, messages: [{ts, body, ctx, from_me?}], count}` — last N WhatsApp messages for one person.
- `orbit_observation_bulk({file_path})` → `{total_lines, batches_posted, total_inserted, total_deduped, failed_batches?}` — streams an NDJSON file of observations to `POST /api/v1/observations`.
- `orbit_person_snapshot_write({person_id, pass_kind, card_state, evidence_pointer_ids, diff_summary, confidence_delta})` → `{ok, id}` — writes one per-pass card snapshot. The enricher emits `pass_kind: "enricher"` snapshots; each is an immutable record of what THIS pass learned. Powers the UI Evolution stack.

From the built-in `anthropic` skill (the founder's `ANTHROPIC_API_KEY` lives on claw):
- `claude-sonnet-4-20250514` — the ONE LLM call per batch. Hardcoded. Do not substitute Haiku, Opus, or any other model.

## Order of operations (5 steps; 2 tools + 1 LLM + 2 tools)

```
1. orbit_persons_list_enriched          (tool, paged until 30 "other" found)
2. for each of the 30 persons:
     orbit_messages_fetch --person-id <id> --limit 30     (tool)
3. ONE Sonnet 4 call: "Given these 30 {id, name, phones, emails, 30 msgs}
   blobs, output {person_id, category, relationship_to_me, company?, title?}
   for each."                                              (SKILL — only LLM step)
4. Write an NDJSON file (one observation per line) and call
   orbit_observation_bulk --file-path /tmp/enrich-<ts>.ndjson  (tool)
5. For each enriched person, call orbit_person_snapshot_write
   with pass_kind='enricher' so the Evolution UI shows this pass. (tool)
```

### Step 1 — Enumerate candidates

Call `orbit_persons_list_enriched({limit: 500})` and keep paginating until you have **30 persons whose latest card has `category === "other"`** (the endpoint returns enriched + skeleton rows; filter to skeletons client-side).

Skip:
- `id` equal to the canary UUIDs (`67050b91-…`, `9e7c0448-…`).
- Persons with zero phones AND zero emails (no handles to probe).
- Persons whose `name` is phone-shaped (`^\+?\d{6,}$`) or contains `@` (name-is-handle — observer should re-run).

Stop after you have 30 qualifying persons OR after exhausting 10 pages — whichever comes first.

### Step 2 — Fetch messages per person

For each of the 30 qualifiers, call `orbit_messages_fetch({person_id, limit: 30})`. Drop any person that returns `count === 0` or an error — no signal means no enrichment (better to leave a skeleton than fabricate).

Build an array `batch[]` of `{person_id, name, phones, emails, messages}`. Truncate each message body to ~200 chars.

### Step 3 — ONE Sonnet 4 call (the LLM step)

Use the built-in `anthropic` skill. Model: **`claude-sonnet-4-20250514`** (hardcoded; do not substitute). `max_tokens: 4096`. System prompt is cached with `cache_control: {type: "ephemeral"}` so re-runs ride the cache.

System (cached):
```
You are Orbit's person-enricher. You classify people in a founder's contact graph into {category, relationship_to_me, company?, title?} given their name, handles, and up to 30 recent WhatsApp messages.

Categories (pick exactly one):
- investor — VC/angel; signals: term sheet, deck, ticket size, diligence, partner at <fund>.
- team — current coworker; daily ops, payroll, HR, standups.
- founder — other founder/CEO of their own company (not Sanchay's).
- friend — personal warmth; non-work topics dominate (family, movies, jokes).
- community — meetup / hackathon / builder-group; no work relationship.
- media / press — journalist, podcast host reaching out for coverage.
- sponsor — paying for / attending a Sanchay-hosted event as sponsor.
- fellow — same accelerator, fellowship, cohort.
- other — genuinely ambiguous (use only when signal is absent, NOT as a default).

Rules:
- relationship_to_me: 1-2 specific sentences, cite the actual signal (e.g. "Met at Bangalore AI hackathon Mar 2025; ongoing WhatsApp thread on inference infra"). Never write filler like "important contact" or "worth keeping in touch".
- company: infer from email domain (@stripe.com → "Stripe") or signature mention. null if unclear.
- title: infer from signature / stated role. null if unclear.
- If messages are empty or bot-like (OTPs, receipts, automated), pick category="other" and say so in relationship_to_me.
- Output JSON ONLY. No preamble, no markdown fences.

Output shape:
{"results": [{"person_id": "<uuid>", "category": "<enum>", "relationship_to_me": "<1-2 sentences>", "company": "<string|null>", "title": "<string|null>", "confidence": <0.6-0.9>}, ...]}
```

User block (per batch):
```
Batch of 30 persons. For each, classify based on the messages shown.

[
  {"person_id": "…", "name": "Meet Shah", "phones": ["+91…"], "emails": [], "messages": [{"ts":"2026-04-18T…","body":"…","ctx":"dm","from_me":false}, …]},
  …
]

Return the JSON.
```

Parse the returned JSON's `results[]`. If parse fails or `results` is missing, log the raw response and abort the batch (do not emit any observations).

### Step 4 — Emit observations via bulk

For each `result`, build one observation envelope:

```json
{
  "observed_at": "<now ISO 8601 with offset>",
  "observer": "wazowski",
  "kind": "person",
  "evidence_pointer": "enrichment://enricher-skill-<YYYY-MM-DD>/person-<person_id>",
  "confidence": <result.confidence>,
  "reasoning": "Enricher batch: classified from <N> WhatsApp messages. Signals: <one-line cue>.",
  "payload": {
    "name": "<original card.name — do NOT change>",
    "company": "<result.company | null>",
    "category": "<result.category>",
    "title": "<result.title | null>",
    "relationship_to_me": "<result.relationship_to_me>",
    "phones": <copy card.phones verbatim>,
    "emails": <copy card.emails verbatim>
  }
}
```

Write one line per envelope to `/tmp/enricher-<timestamp>.ndjson` and call `orbit_observation_bulk({file_path: "/tmp/enricher-<timestamp>.ndjson"})`.

Expected response: `{ok: true, total_lines: N, batches_posted: 1, total_inserted: N, total_deduped: 0}`. A subsequent run with the same `evidence_pointer` will dedupe — that's fine.

### Step 5 — Write one per-pass snapshot per enriched person

For every person that actually got an observation in Step 4 (i.e. `result` present + envelope written), call `orbit_person_snapshot_write` ONCE with `pass_kind: "enricher"`.

The snapshot records what THIS pass learned about this person. Observations remain the append-only source of truth; snapshots are a UI-facing projection that makes pass boundaries explicit and preserves the LLM-generated `diff_summary` text, which isn't reconstructible from observations.

For each enriched person, call:

```
orbit_person_snapshot_write({
  person_id: "<uuid>",
  pass_kind: "enricher",
  card_state: {
    name: "<original card.name>",
    company: "<result.company|null>",
    category: "<result.category>",
    title: "<result.title|null>",
    relationship_to_me: "<result.relationship_to_me>",
    phones: <card.phones>,
    emails: <card.emails>
  },
  evidence_pointer_ids: [],  // V1 enricher: empty — the evidence_pointer
                              // on the kind:"person" observation is a URI,
                              // not a UUID. If you want to link to the
                              // observation's DB id, look it up from the
                              // bulk response; otherwise leave empty.
  diff_summary: "Classified as <category>. Signals: <one-line cue — same as 'reasoning' in the observation>.",
  confidence_delta: {
    category: <result.confidence>,
    relationship_to_me: <result.confidence>
  }
})
```

Expected response: `{ok: true, id: "<snapshot_uuid>"}`.

If the snapshot write fails (e.g. 404 — person was deleted between steps), log and continue with the next person — the observation already landed in Step 4, so the card is updated; a missing snapshot just means the Evolution stack won't show this pass (a soft degrade, not a failure).

Keep a running `snapshot_ids[]` of successful snapshot IDs to include in the final summary.

### Final summary

Return a JSON summary (the dispatcher parses this):

```json
{
  "ok": true,
  "status": "succeeded",
  "batch_size": 30,
  "enriched": 27,
  "skipped_no_signal": 3,
  "skipped_canary": 0,
  "inserted": 27,
  "deduped": 0,
  "snapshots_written": 27,
  "category_shift": {"friend": 8, "community": 6, "founder": 4, "team": 3, "fellow": 3, "other": 3},
  "cost_usd": 0.04
}
```

## Hard rules

- **One Sonnet 4 call per batch.** Never loop Claude per person.
- **Batch ≤ 30.** If the caller asks for more, cap at 30 and return.
- **Skip Umayr + Ramon.** Canaries, always.
- **Never mutate identity fields** (name, phones, emails). Enricher is about interpretation, not identity.
- **`evidence_pointer` must include the date + person_id** so reruns dedupe correctly on the same calendar day.
- **Model is `claude-sonnet-4-20250514`.** Hardcoded. Do not use Haiku 4.5 — it's not on Sanchay's key catalog.

## Worked example

Caller brief: `Run the orbit-enricher skill. Brief: enrich up to 30 category='other' persons.`

You:
1. `orbit_persons_list_enriched({limit: 500})` → page 1 of 500; filter client-side to 82 `"other"` persons → take first 30 (skip canaries).
2. For each of 30: `orbit_messages_fetch({person_id, limit: 30})` → 28 have ≥1 message, 2 have 0 → drop the 2.
3. ONE Sonnet 4 call with 28-entry batch. Response:
   ```
   {"results":[{"person_id":"…","category":"community","relationship_to_me":"Met at Delhi hackathon; WhatsApp thread on model serving.","company":"Groq","title":null,"confidence":0.8}, …]}
   ```
4. Write 28 lines to `/tmp/enricher-2026-04-20T12-00.ndjson`, call `orbit_observation_bulk({file_path})` → `{total_inserted: 28}`.
5. For each of the 28 enriched persons, call `orbit_person_snapshot_write({person_id, pass_kind:"enricher", card_state, diff_summary, confidence_delta})` → collect 28 new snapshot IDs.

Final JSON summary returned to the dispatcher.

## Failure modes

- `orbit_persons_list_enriched` → `AUTH_FAILED`: exit with `{ok:false, status:"failed", error:"AUTH_FAILED"}`.
- Sonnet 4 call returns non-JSON or times out: exit with `{ok:false, status:"failed", error:"llm_parse_error", raw:"<first 500 chars>"}`. Do NOT emit partial observations.
- `orbit_observation_bulk` returns `failed_batches.length > 0`: include it in the summary but still set `ok: true` if `total_inserted > 0`. The dispatcher will see partial success.
- Budget ceiling: one Sonnet 4 call on ≤30 persons with ≤30 msgs each is well under $0.10 — no explicit budget guard needed for V0.
