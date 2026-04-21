---
name: orbit-topic-resonance
description: Batched NER pass over local WhatsApp messages to extract per-person topic weights and POST them to Orbit via the CLI.
metadata: {"openclaw":{"emoji":"🧲"}}
---

# orbit-topic-resonance

## When to use

- Sanchay asks "refresh topics", "rebuild topic resonance", "what is Umayr / Meet / … talking about".
- First-time bulk topic extraction after a fresh wacli snapshot.
- After a large chunk of new messages has landed (more than ~500) and you want the topic cloud to reflect them.

## When NOT to use

- For a single person's topic refresh — this pass is designed for bulk.
- Without `ANTHROPIC_API_KEY` configured on the claw.
- If you don't have fresh `~/.wacli/wacli.db` + `~/.wacli/session.db` — stale snapshots produce stale topics.

## Safety

- Read-only against `~/.wacli/wacli.db` + `~/.wacli/session.db`. Never writes to them.
- Never bypasses the Orbit API. Every topic write goes through `orbit_topics_upsert` (which wraps `POST /api/v1/person/:id/topics`).
- Topics are atomic-replace: each person's prior topic list is wiped and replaced with the new one. Safe because this pass re-derives from the full local message history every time.
- Budget ceiling: $10. Halt if exceeded.
- On HTTP 4xx other than 404, log + quarantine — do NOT retry forever.

## Your tools

From `orbit-cli` plugin — four verbs do all the plumbing:
- `orbit_persons_list_enriched()` → `{persons[]}` — paginated list of enriched persons (phones + emails).
- `orbit_messages_fetch({person_id, limit})` → `{messages:[{ts, body, ctx}]}` — reads `~/.wacli/wacli.db` on claw, bridges phone→LID via session.db, dedupes, returns the last N DM + group-authored messages for one person.
- `orbit_topics_upsert({person_id, topics}|{person_id, file})` → `{count}` — POSTs the merged topic list for one person.
- `orbit_topics_get({person_id, limit})` → `{topics[], total}` — for the top-topics summary at the end of the run.

From the Anthropic SDK (via the built-in `anthropic` skill):
- `claude-haiku-4-5` for topic extraction — the ONLY LLM spend in this SKILL.

## Order of operations (4 steps; 3 tools + 1 batched LLM + 1 tool)

```
1. orbit_persons_list_enriched                                      (tool, paged)
2. for each person with DM signal:
     orbit_messages_fetch --person-id <id> --limit 200              (tool)
3. Batch 30 persons per Haiku call:                                 (SKILL — only LLM step)
     "Extract top 10 topics for each person" → topics_map
4. for each person_id:
     orbit_topics_upsert --person-id <id> --topics [...]            (tool)
```

### Step detail

**1. Enumerate persons.**
Call `orbit_persons_list_enriched()`. Filter to persons with ≥1 phone (only those can have WhatsApp messages). Expect ~1500 persons.

**2. Gather messages per person.**
For each person, call `orbit_messages_fetch({person_id, limit: 200})`. The tool handles SQLite reads, the phone→LID bridge, and de-dup by `ts+body` prefix on claw. You receive `{person_id, messages:[{ts, body, ctx, from_me?}], count}`.

Persons with `count == 0` (or `reason: "no_phones_on_card"`) are dropped from the rest of the pass.

**3. Batched topic extraction (THE LLM STEP).**
For every person with ≥1 message, call Haiku 4.5 in a batch of ~30 persons per call. Cache the system prompt (the canonical topic-extraction instructions — see `scripts/topic-resonance.mjs` for the prompt text).

Per-call user block:
```
INPUT:
[
  {"name": "<person.name>", "person_id": "<uuid>", "messages": [{"body": "...", "ctx": "dm"}, ...]},
  {"name": "<person.name>", "person_id": "<uuid>", "messages": [...]}
]
```

Haiku returns `{topics_map: {person_id: [{topic, weight}, ...]}}`. Merge per-person lists if a person spans multiple calls (heaviest-normalized, MAX 20 topics, minimum weight 0.15).

**4. Upsert per-person topic lists.**
For each person with ≥1 merged topic, call `orbit_topics_upsert({person_id, topics: [...]})`. Atomic replace — Orbit wipes prior topics and writes the new list.

Failed upserts are logged but do not abort the run.

**5. Print the final summary.**
Use `orbit_topics_get` to sample a few high-score persons to sanity-check. Then print:
- Persons scanned / with messages / with topics / posted OK.
- Anthropic cost.
- Top 5 topics by person-count.
- Topic-count distribution.

## The "fat driver" fallback

If you can't orchestrate the 4 steps interactively (e.g. the agent is operating under a strict single-tool-at-a-time pattern), invoke the packaged node script which does the same dance:
```
cd ~/orbit-pipeline-tmp
node --env-file=$HOME/.openclaw/.env scripts/topic-resonance.mjs
```
The script uses the same CLI verbs under the hood via direct `fetch` (internal, not the SKILL's concern). Prefer the 4-step SKILL flow for visibility; fall back to the script only when the agent needs to delegate the whole loop.

## Failure modes

- `orbit_persons_list_enriched` returns `{error:{code:"AUTH_FAILED"}}` → abort early, don't burn Haiku.
- `orbit_messages_fetch` returns `{error:{code:"FILE_NOT_FOUND"}}` on `wacli.db` → abort early.
- Haiku 429 / 5xx on one batch → log, skip those persons' topics for this run; continue.
- `orbit_topics_upsert` returns `{error:{code:"NOT_FOUND"}}` on a person_id → logged, counted as failed, doesn't abort the run.
- Budget ceiling hit → halt; partial progress is already saved.

## Observations + invariants

- We do NOT emit `kind:"person"` observations from this pass. Topic data lives in its own `person_topics` table, not the observation ledger. Rationale: topics are a derived, high-churn projection, not a factual claim about the human.
- Future: if we want topic deltas over time, we add a `person_topic_history` table. Out of scope for V0.
- The `PersonPanel.tsx` chip cloud reads from `GET /api/v1/person/:id/topics` on panel open (via `orbit_topics_get` when an agent is inspecting).

## Example invocation (the 4-step flow)

```
# 1. list persons
> orbit_persons_list_enriched()
{persons: [{id: "aaaa...", name: "Meet", phones: ["+91..."]}, ...]}  # ~1500 rows

# 2. fetch messages for each (batched)
> orbit_messages_fetch({person_id: "aaaa...", limit: 200})
{person_id: "aaaa...", messages: [{ts, body, ctx}, ...], count: 47}

# 3. Haiku extraction (internal)
# Sanchay's agent batches 30 persons per Haiku call, extracts topics,
# merges sub-batch outputs per person.

# 4. POST merged topics
> orbit_topics_upsert({person_id: "aaaa...", topics: [{topic:"aakaar",weight:1},{topic:"reels",weight:0.4}]})
{count: 2}

# final summary (per-person sanity)
> orbit_topics_get({person_id: "aaaa...", limit: 10})
{topics: [{topic:"aakaar",weight:1},...], total: 2}
```

## Ratio note (Phase 4.5)

This SKILL is 1 + N + N CLI-verb calls (list + fetch-per-person + upsert-per-person) and ⌈N/30⌉ Haiku calls. For N=1000 persons that's ~2000 verb calls vs ~34 Haiku calls — **59:1** tools-to-LLM, far past 60/40.
