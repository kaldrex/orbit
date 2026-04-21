---
name: orbit-topic-resonance
description: Batched NER pass over local WhatsApp messages to extract per-person topic weights and POST them to Orbit.
metadata: {"openclaw":{"emoji":"🧲"}}
---

# orbit-topic-resonance

## When to use

- Sanchay asks "refresh topics", "rebuild topic resonance", "what is Umayr / Meet / … talking about".
- First-time bulk topic extraction after a fresh wacli snapshot.
- After a large chunk of new messages has landed (more than ~500) and you want the topic cloud to reflect them.

## When NOT to use

- For a single person's topic refresh — this pass is designed for bulk. (A single-seed observer already emits enough signal for downstream use.)
- Without ANTHROPIC_API_KEY configured on the claw.
- If you don't have fresh `~/.wacli/wacli.db` + `~/.wacli/session.db` — stale snapshots produce stale topics.

## Safety

- Read-only against `~/.wacli/wacli.db` + `~/.wacli/session.db`. Never writes to them.
- Never bypasses the Orbit API. Every topic write goes through `POST /api/v1/person/:id/topics` with Bearer auth.
- Topics are atomic-replace: each person's prior topic list is wiped and replaced with the new one. Safe because this pass re-derives from the full local message history every time.
- Budget ceiling: $10. Script exits early if exceeded.
- On any HTTP 4xx from Orbit other than 404, log + quarantine — do NOT retry forever.

## Your tools

This SKILL invokes a single Node script — `scripts/topic-resonance.mjs`. The script handles:
- Fetching persons via `/api/v1/persons/enriched` (paginated)
- Loading `whatsmeow_lid_map` from `session.db` for phone→LID bridging
- Gathering DM + group messages per person from `wacli.db`
- Batched Haiku 4.5 calls (BATCH_SIZE=30 messages, CONCURRENCY=4) with prompt caching
- Merging sub-batch topic lists per person (heaviest-normalized, MAX 20 topics)
- POSTing to `/api/v1/person/:id/topics`
- Progress + resume via `scripts/lib/resilient-worker.mjs`

You do NOT call Haiku yourself in this SKILL. The script owns the LLM loop. Your role is to:
1. Verify preconditions.
2. Kick off the script with the right env.
3. Surface the summary when done.

## Order of operations

1. **Verify preconditions.**
   - `test -f ~/.wacli/wacli.db` — fail fast if missing.
   - `test -f ~/.wacli/session.db` — fail fast if missing.
   - `grep -q ANTHROPIC_API_KEY ~/.openclaw/.env` — fail fast if missing.
   - `grep -q ORBIT_API_URL ~/.openclaw/.env && grep -q ORBIT_API_KEY ~/.openclaw/.env` — fail fast if missing.

2. **Run the script.**
   ```
   cd ~/orbit-pipeline-tmp
   node --env-file=$HOME/.openclaw/.env scripts/topic-resonance.mjs
   ```
   Expect: 5-20 minute wall clock, depending on #persons. Script prints per-batch progress, final `summary: …` line, and writes `outputs/topic-resonance-<date>/summary.json`.

3. **Surface the summary.**
   Print:
   - Persons scanned / with messages / with topics / posted OK.
   - Anthropic cost.
   - Top 5 topics across all persons (from `summary.json → top_topics`).
   - Topic-count distribution (how many persons got 0 topics, 1-3, 4-6, …).

## Failure modes

- `ORBIT_API_URL` unreachable → abort early, don't burn Haiku.
- `wacli.db` locked by running `wacli` daemon → copy to a tmp file first, then run against the copy.
- Haiku 429 / 5xx → `ResilientWorker` retries with exponential backoff; sub-batch quarantined after 3 attempts.
- A per-person POST failing → logged, counted as failed, doesn't abort the run.
- Budget ceiling hit → worker halts, partial progress is already saved in `perPerson` map; summary reflects what completed.

## Observations + invariants

- We do NOT emit `kind:"person"` observations from this pass. Topic data lives in its own `person_topics` table, not the observation ledger. Rationale: topics are a derived, high-churn projection, not a factual claim about the human. Re-running the pass should not bloat the observation ledger with near-duplicate records.
- Future: if we want topic deltas over time (e.g. "Meet stopped talking about Aakaar in April"), we add a `person_topic_history` table. Out of scope for V0.
- The `PersonPanel.tsx` chip cloud reads from `/api/v1/person/:id/topics` on panel open. It hides entirely if there are zero topics — so a failed run for a person doesn't leave a misleading "no topics" state visible.

## Example invocation

```
$ node --env-file=$HOME/.openclaw/.env scripts/topic-resonance.mjs
[0.2s] starting — wacli=/home/sanchay/.wacli/wacli.db session=/home/sanchay/.wacli/session.db
[1.4s] phase 1: fetched 1600 persons with phones
[1.4s] phase 1: loaded 2134 phone→LID entries
[8.2s] phase 2: persons with messages=923, empty=677, total msgs=24441
[8.4s] phase 3: 923 persons × avg 1.4 sub-batches = 1312 LLM calls
[9.1s] warm: person=Meet topics=3 cost=$0.0014 cache_w=2170
…
[412.3s] phase 4: posted=903, failed=20
summary: … top5=aakaar(42),dubai(31),fundraising(27),hiring(24),reels(19)
```
