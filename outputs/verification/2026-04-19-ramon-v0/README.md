# V0 Orbit — Ramon end-to-end verification (Iteration 2)

**Date:** 2026-04-19
**Path:** `Wazowski (claw) → orbit-observer skill → orbit-rules plugin → orbit-resolver skill → POST /api/v1/observations → auto-merge RPC → GET /api/v1/person/:id/card`

**What's different from the Umayr pass:** single agent turn runs both observer and resolver; the resolver's `kind:"merge"` observation POST auto-materializes the `persons` row + `person_observation_links` via the upgraded `upsert_observations` RPC. **No dev-Mac psql needed.**

## Scorecard

| signal | hit | evidence |
|---|---|---|
| Name identified | ✅ | `Ramon Berrios` |
| Phones found | ✅ | 2 phones — `+17874244135` (primary, Puerto Rico), `+13057974114` (US Miami) |
| Emails found | ✅ | `ramongberrios@gmail.com` |
| Cross-source joined | ✅ | WhatsApp + Gmail + Calendar merged into one person record |
| Interactions summarized | ✅ | 3 interactions: Gemz onboarding email, weekly Feb-Mar calls, April WA debugging collaboration |
| Relationship context captured | ✅ | "Freelance client and close collaborator. Founder of Gemz (influencer marketing SaaS) via Wynami Inc. Pays Sanchay for technical work..." |

**6/6 again, and through the fully-agentic path this time.**

## What the agent printed

> *observer: observed seed=17874244135@s.whatsapp.net threads=3 interactions=3 persons=1 posted inserted=4 deduped=0*
>
> *resolver: buckets=1 deterministic-merges=1 heuristic-merges=0 escalated=0 persons=1 linked-interactions=3 (person_id=9e7c0448-dd3b-437c-9cda-c512dbc5764b, bridges: phone:+17874244135 + phone:+13057974114 + email:ramongberrios@gmail.com + lid:134875545870546)*
>
> *dropped 8 gmail threads — all from hello@usegemz.io / support@usegemz.io (bot class, gemz marketing test emails). kept: 1 WA DM, 1 consolidated meeting cadence (10 calendar invites → 1 obs), 1 forwarded email.*

## What's notably good

- **Different `category` than Umayr** — `founder` here vs `friend` for Umayr, driven by the actual relationship (paid client + SaaS founder). Real classification, not default-to-"other".
- **Two phones** resolved via the same person. The agent found an additional Miami number beyond the WhatsApp one.
- **10 calendar invites consolidated into 1 interaction observation** per the KNOWS-edge rule. The agent correctly treated them as a single recurring meeting series.
- **8 gemz.io bot emails dropped** by the safety filter — no `noreply@`, no `support@` chaff in the basket.

## What's still rough

- `one_paragraph_summary` still has the duplication seam between `relationship_to_me` and the latest interaction (carried over from the Umayr card). Fix in `card-assembler.ts`.
- The "Gemz SaaS" vs "Wynami Inc" company split is a real nuance the agent got right prose-wise (Wynami = parent, Gemz = product) but the `company` field just says "Wynami Inc". Arguably that's correct for a `category: founder` row.
- LID `134875545870546` was resolved via `orbit_rules_lid_to_phone` — first live use of that tool against the real 14,995-row session.db. Worked.

## Artifacts

- `card.json` — the full card (6 top-level fields + 3 linked interactions)
- `basket.txt` — the 5 rows linked to this person (person, 3 interactions, 1 merge)

## How the auto-merge path works (the upgrade this iteration)

The `upsert_observations` RPC was amended to, on a `kind:"merge"` row:
1. Upsert `persons (id = payload.person_id, user_id = caller)`
2. Insert `person_observation_links` for every UUID in `payload.merged_observation_ids`
3. Self-link the merge observation itself

See `supabase/migrations/20260419_upsert_observations_auto_merge.sql`.
