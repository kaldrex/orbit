# V0 Orbit — Umayr end-to-end verification

**Date:** 2026-04-19
**Path:** `Wazowski (claw) → orbit-observer skill → orbit-rules plugin → POST /api/v1/observations → Supabase → manual merge → GET /api/v1/person/:id/card`
**Success criterion (locked this session):** one concrete, honest human card for Umayr.

## Scorecard

| signal | hit | evidence |
|---|---|---|
| Name identified | ✅ | `Umayr Sheik` from cross-source merge |
| Phones found | ✅ | `+971586783040` (normalized from WhatsApp jid via `orbit_rules_normalize_phone`) |
| Emails found | ✅ | 3 canonical: `usheik@sinxsolutions.ai`, `usheik@weddingdai.com`, `umayrsheik@gmail.com` |
| Cross-source joined | ✅ | WhatsApp + Gmail + Google Contacts bridged into one person record |
| Interactions summarized | ✅ | 4 interactions across 2025-02 → 2026-04 with real topics/sentiments/summaries |
| Relationship context captured | ✅ | "Close friend and tech peer based in Dubai. One of the few people Sanchay considers a match for deep AI/ML discussions..." |

**6/6 on the first run.**

## What Wazowski did (from session `7318f901` on claw)

Tool calls made during the observer pass:
- `orbit_rules_domain_class` × 5
- `orbit_rules_canonicalize_email` × 3
- `orbit_rules_normalize_phone` × 1
- `orbit_rules_lid_to_phone` × 1
- `exec` (wacli + gws) × 27

Safety drops applied: **5 bot emails dropped** (drive-shares-noreply, comments-noreply, popl list-unsubscribe, calendar accept).

Final summary the agent printed:
> *observed seed=971586783040@s.whatsapp.net threads=4 interactions=4 persons=1 posted inserted=5 deduped=0*

## Resolver pass (same session, separate turn)

> *resolver buckets=1 deterministic-merges=0 heuristic-merges=0 escalated=0 persons=1 linked-interactions=4*

One bucket, one person, 5 deterministic bridges (1 phone + 3 emails + 1 LID). All 4 interactions linked via exact-name-match against the single person observation (score 1.0).

**V0 limitation:** no HTTP endpoint exists yet to create the `persons` row + `person_observation_links` from the agent side. The resolver's output was a JSON plan; the persons row + links + merge observation were inserted from the dev Mac via psql. Next iteration: add a `POST /api/v1/persons` route so the resolver can execute end-to-end.

## Correction round-trip (also verified)

- Card before: `category: "friend"`
- POST `/api/v1/person/:id/correct` with `{field:"category", new_value:"team", source:"telegram"}`
- Card after: `category: "team"` + correction visible under `observations.recent_corrections[]`

Corrections from the founder override the agent's category classification. No Orbit UI involved — the surface is Telegram (or any human-in-the-loop path that relays into Wazowski).

## Artifacts

- `card.json` — the full assembled card after observer + resolver + correction
- `basket.txt` — the 5 observations in the basket (4 interactions + 1 person) + the merge + correction rows

## What's still rough (honest)

- `one_paragraph_summary` field has mild duplication between `relationship_to_me` and the latest interaction summary. Fix in `src/lib/card-assembler.ts` — either dedupe the two or show them as separate UI fields.
- No `POST /api/v1/persons` route — resolver can't complete without dev-machine assist. Fix next iteration.
- Observer + resolver required two separate agent turns. Next iteration: one prompt that runs both.
- LLM-judgement fields (topic, sentiment, relationship_context) drifted across the two agent turns — acceptable per the locked principles but worth re-running to see variance.
- Only one human tested. The 5 topology-diverse seeds from `agent-docs/10-eda-findings.md` are the next test.

## How to reproduce

```bash
# From dev Mac
cd /Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19
./dev  # starts Next.js on :3047

# From claw (or local ssh claw)
openclaw agent --agent main --thinking medium --timeout 240 --message \
  "Execute the orbit-observer skill for seed 971586783040@s.whatsapp.net..."
```

Full commands + exact prompts: see the session log of the parent Claude turn.
