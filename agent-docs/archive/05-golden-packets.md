# 05 · Golden packets (ARCHIVED)

> **Archived 2026-04-20. Superseded by the V0 card assembler.** The three fixtures in `tests/fixtures/golden-packets/` (Imran/Aryan/Hardeep) were from the 2026-04-18 v3 hypothesis test and were never re-generated against the post-V0 pipeline. They are shape-examples of the packet contract, not acceptance tests. The live card contract is [src/lib/card-assembler.ts](../../src/lib/card-assembler.ts) (pure function, 8 unit tests at `tests/unit/card-assembler.test.ts`) feeding `GET /api/v1/person/:id/card`. Umayr + Ramon cards are the canaries preserved across every pipeline change; they are byte-identical to their April-19 baselines. Do not use this doc as an acceptance gate.
>
> Track 3's acceptance contract. The packet assembler is done when its output diff-cleans against these three fixtures.

## What the packet is

The **person packet** is the unit of value for Orbit. One JSON object per human, combining canonical identity, cross-channel activity, relationship health, segment, and LLM-enriched context. It's what UI renders and what OpenClaw agents read before acting. See [01-vision.md](./01-vision.md) for the why, [02-architecture.md](./02-architecture.md) for how it sits in the pipeline.

## The three fixtures

Location: [tests/fixtures/golden-packets/](../tests/fixtures/golden-packets/). Source: the 2026-04-18 v3 hypothesis test against Sanchay's real data. Each fixture exercises one demo property that the architecture must prove.

| File | Person | What it proves |
|---|---|---|
| [person_packet_imran.json](../tests/fixtures/golden-packets/person_packet_imran.json) | Imran Sable | Cross-source identity resolution — one phone + two emails → one person. Trend is RISING. |
| [person_packet_aryan_yadav.json](../tests/fixtures/golden-packets/person_packet_aryan_yadav.json) | Aryan Yadav | Going-cold detection — 150 interactions, 18 days quiet, with specific unanswered questions preserved. |
| [person_packet_hardeep.json](../tests/fixtures/golden-packets/person_packet_hardeep.json) | Hardeep Gambhir | Weak-signal handling — 21 shared WhatsApp groups materialized as `CO_PRESENT_IN` edges, not primary relationship signal. |

Fixture-level context: [tests/fixtures/golden-packets/README.md](../tests/fixtures/golden-packets/README.md).

## Packet shape (top-level)

Every packet has exactly these eight top-level keys:

- `person_id` — string
- `canonical_name` — string
- `aliases` — array of strings
- `identifiers` — object: `{ phones_e164, emails, whatsapp_jids }`
- `channels` — object: `{ whatsapp, gmail, calendar }` (extendable when Slack + Linear land)
- `relationship` — object: `{ first_touch, last_touch, days_since_last, total_interactions, bidirectional, intensity_score, going_cold, trend }`
- `segment` — object: `{ primary, confidence, evidence }`
- `context` — object: `{ recent_topics, shared_groups, outstanding_action_items }` (+ optional `_note_*` fields carrying provenance)

This is the shape the assembler must produce. Reading one fixture top-to-bottom is the fastest way to absorb the contract.

## Diff contract

Track 3's assembler (`src/lib/packet.ts`, not yet written) must produce JSON that is **structurally equal** to each fixture when fed the same source data subset. Acceptable drift:

- Field ordering in objects (JSON objects are unordered)
- Timestamp precision at the seconds level
- LLM-produced prose fields (`recent_topics`, `outstanding_action_items`) — these are inherently non-deterministic; drift is allowed *in wording* but not in presence/absence or schema.

Not acceptable:

- Missing or extra top-level keys
- Changed `identifiers`, `channels`, `relationship`, `segment.primary`, `aliases` — these are derived deterministically and must match exactly
- `going_cold` boolean flipping
- `trend` label changing
- `total_interactions` off by more than ±1

## How to test locally

Once the assembler exists:

```
# expected shape (pseudocode)
import { assemblePacket } from "@/lib/packet"
const actual = await assemblePacket(userId, personId)
const expected = JSON.parse(readFileSync("tests/fixtures/golden-packets/person_packet_imran.json"))
expect(stripNonDeterministic(actual)).toEqual(stripNonDeterministic(expected))
```

Integration tests live under [tests/integration/](../tests/integration/). Add one per fixture. Follow the shape in [tests/integration/raw-events-endpoint.test.ts](../tests/integration/raw-events-endpoint.test.ts) for how to stub auth + hit the route.

## Why these three and not more

Testing contract in [docs/superpowers/specs/2026-04-18-testing-and-verification.md](../docs/superpowers/specs/2026-04-18-testing-and-verification.md) §2.3 says three canonical fixtures are enough for V0: they cover the three failure modes (cross-source merge, time-decay detection, weak-signal noise). More fixtures will come with Track 4 (LLM enrichment fields) and Track 5 (UI rendering tests). For now, three.
