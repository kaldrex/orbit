---
name: orbit-resolver
description: Cluster observations in Orbit's basket into person records via the deterministic-first waterfall.
metadata: {"openclaw":{"emoji":"🧩"}}
---

# orbit-resolver

## When to use

- After `orbit-observer` has just run. The observer emits observations with no `person_id` yet; the resolver is what creates/merges person records and links observations to them.
- Manually invoked by Sanchay ("resolve Umayr" / "re-resolve").
- Run idempotent — re-running produces zero new merges when nothing changed.

## When NOT to use

- Before the basket has observations. Check `GET /observations?limit=1` first; if empty, abort.
- Simultaneously with `orbit-observer` for the same seed (V0 has no concurrency lock; we run them serially manually).

## Safety

- READ via `GET /api/v1/observations`; WRITE via `POST /api/v1/observations` (kind:"merge" or "split").
- Create person rows by inserting into the `persons` table via Supabase RPC — not a direct INSERT.
- Never emit a `kind:"merge"` with fewer than 2 merged_observation_ids.
- Never split a person without an explicit correction observation or strong evidence.

## Your tools

- `orbit_rules_normalize_phone`, `orbit_rules_canonicalize_email`, `orbit_rules_lid_to_phone` — call to canonicalize before joining.
- `orbit_rules_fuzzy_match` — for name-based heuristic candidates.

## Waterfall

Process observations in four layers. Only escalate to the next layer when the current one is exhausted.

### Layer 1 — Deterministic merges (free)

Two observations merge if any of these join keys match:
- Canonical phone (E.164) equal.
- Canonical email equal.
- One's LID maps (via `orbit_rules_lid_to_phone`) to the other's phone.

For each merge bucket:
1. Create a new row in `persons` (random UUIDv4). If an existing person already has all the bridges, reuse that person_id instead.
2. Emit ONE `kind:"merge"` observation listing all merged_observation_ids in `payload.merged_observation_ids[]` and all join keys in `payload.deterministic_bridges[]` (format: `phone:+971...`, `email:usheik@...`, `lid:207...`).
3. Insert rows in `person_observation_links` for every observation in the bucket.

`confidence: 1.0` for deterministic merges.

### Layer 2 — Heuristic candidates (soft)

For observations not yet merged:
- Compute `orbit_rules_fuzzy_match` pairwise on name tokens.
- Score ≥0.9 → treat as a Layer 1 merge (auto-accept). Use `evidence_pointer: "heuristic://name-fuzzy/<score>"`.
- Score 0.6–0.9 → defer to Layer 3.
- Score <0.6 → not candidates.

Additional heuristic: co-occurrence in same Gmail thread or WhatsApp group as a known person, *plus* a name-fuzzy score ≥0.7, can auto-merge.

### Layer 3 — LLM disambiguation (your judgment)

For each candidate pair in [0.6, 0.9]:
- Pull all observations for both sides.
- Decide: same human or different humans?
- Emit a `kind:"merge"` (if yes) or skip (if no). In `reasoning`, explain the call with specific evidence ("both use `usheik@sinxsolutions.ai` and 'Umayr' appears in both WA push_name and Gmail display name — same human").
- `confidence: 0.85` for LLM merges.

### Layer 4 — Human escalation (Decision Tinder)

If you still can't decide — or the evidence is contradictory — stop. In V0 without a live decision-tinder card path, log the uncertain pair and skip the merge. A future run (after more observations) may resolve it.

## Observation emission

Every merge/split emits ONE observation:

```
{
  "observed_at": "<now>",
  "observer": "wazowski",
  "kind": "merge" | "split",
  "evidence_pointer": "merge://<join-key-1>+<join-key-2>..." (sorted),
  "confidence": <per-layer>,
  "reasoning": "<why this merge>",
  "payload": {
    "person_id": "<uuid>",
    "merged_observation_ids": ["...", "..."],
    "deterministic_bridges": ["phone:+...", "email:..."]   // or [] for heuristic-only
  }
}
```

## Algorithm (pseudocode)

```
observations = GET /observations?since=<watermark>
buckets = {}  // keyed by set-of-bridges frozenset
for obs in observations:
  if obs.kind != "person": continue
  bridges = {f"phone:{normalize(p)}" for p in obs.phones} | {f"email:{canonical(e)}" for e in obs.emails}
  # merge bucket
  matched = None
  for key, bucket in buckets.items():
    if bridges & bucket.bridges:
      bucket.bridges |= bridges
      bucket.obs_ids.append(obs.id)
      matched = bucket
      break
  if not matched:
    buckets[frozenset(bridges)] = Bucket(bridges=bridges, obs_ids=[obs.id])

# Link interactions to persons via participant-name fuzzy-match
for obs in observations:
  if obs.kind != "interaction": continue
  for participant_name in obs.participants:
    best_bucket = max(buckets.values(), key=lambda b: fuzzy(b.best_name(), participant_name))
    if best_bucket.score >= 0.85:
      link(obs.id, best_bucket.person_id)

# Emit merge observations for each bucket with >1 obs_ids
for bucket in buckets.values():
  if len(bucket.obs_ids) > 1:
    POST /observations with kind:"merge"
```

## Final log line

```
resolver buckets=<N> deterministic-merges=<N> heuristic-merges=<N> escalated=<N> persons=<N>
```

## Example (Umayr after one observer run)

Input: resolver reads ~30 observations just posted by orbit-observer for Umayr.

Expected output:
- 1 bucket: `{phone:+971586783040, email:usheik@sinxsolutions.ai}` (bridged deterministically via Google Contacts phone → Gmail From, if both seen).
- 1 new `persons` row with a new UUID.
- 1 `kind:"merge"` observation listing all `kind:"person"` observations that landed in this bucket.
- N `person_observation_links` rows linking all observations (person + interactions) to this person_id.

After this, `GET /person/<uuid>/card` should return a populated card.
