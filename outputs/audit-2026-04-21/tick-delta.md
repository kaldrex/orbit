# Evolution Tick Delta — 2026-04-21

**Before:** 2026-04-21T07:26:00.936Z · **After:** 2026-04-21T07:47:07.883Z

## Totals

| Metric | Before | After | Δ |
|---|---:|---:|---:|
| observations total | 29768 | 29968 | 200 |
|   obs kind:correction | 1 | 1 | 0 |
|   obs kind:interaction | 11762 | 11762 | 0 |
|   obs kind:merge | 13359 | 13359 | 0 |
|   obs kind:person | 4646 | 4846 | 200 |
| persons total | 1602 | 1602 | 0 |
| neo4j Person nodes | 1602 | 1602 | 0 |
|   edge :DM | 135 | 135 | 0 |
|   edge :EMAILED | 2 | 2 | 0 |
|   edge :SHARED_GROUP | 1095 | 1095 | 0 |

## Category distribution

| Category | Before | After | Δ |
|---|---:|---:|---:|
| community | 90 | 90 | 0 |
| fellow | 282 | 282 | 0 |
| founder | 31 | 31 | 0 |
| friend | 101 | 107 | 6 |
| media | 5 | 5 | 0 |
| other | 1055 | 1047 | -8 |
| sponsor | 20 | 22 | 2 |
| team | 18 | 18 | 0 |

## Enricher run

- 200 persons passed through enricher-v5-haiku
- 8 promoted out of `other` into a specific category
- 192 stayed `other` (pure saved contact, no activity signal)
- cost_actual_usd: **$0.1631** (model: claude-haiku-4-5-20251001)
- wall time: 53s, 7 batches × 30, zero quarantine

## Umayr canary diff (must be UNCHANGED)

| Field | Before | After | Changed? |
|---|---|---|---|
| category | friend | friend | NO |
| name | Umayr Sheik | Umayr Sheik | NO |
| company | SinX Solutions | SinX Solutions | NO |
| title | Founder | Founder | NO |
| relationship_to_me | Close friend and tech peer based in Dubai. One of the few people Sanchay conside | Close friend and tech peer based in Dubai. One of the few people Sanchay conside | NO |

**Canary verdict:** ✓ PASSED — Umayr unchanged on all 5 core fields

## Meet topic chips

- Before: 11 chips
- After:  11 chips

## 3 example persons promoted out of `other`

### 1. Lakshmi — `other` → `sponsor`

- **person_id:** `0feaacb9-71b3-4e8a-8e23-f9d2c8ee2e94`
- **company:** fn7.io
- **title:** null
- **confidence:** (not stored)
- **relationship_to_me:** Recruiter or talent scout from fn7.io who reached out to Sanchay as a promising full-stack engineer.
- **reasoning:** Email from fn7.io domain with subject 'Build the next billion-dollar AI platform' and snippet targeting full-stack engineers — clear talent acquisition outreach.

### 2. Chris McCreery — `other` → `sponsor`

- **person_id:** `29a48de8-adfb-45ff-8e92-f890bb0b645f`
- **company:** null
- **title:** Digital Expert & Measurement and Performance
- **confidence:** (not stored)
- **relationship_to_me:** Digital expert and measurement consultant; booked consultation with Sanchay via Fiverr for tracking implementation work.
- **reasoning:** Email threads show consultation appointments booked via Fiverr, discussion of tracking implementation with third parties (Ramon), and title signature 'Digital Expert & Measurement and Performance' — indicates service provider/sponsor relationship.

### 3. V — `other` → `friend`

- **person_id:** `1b8cfc63-2cfb-47c5-b74e-32029895048f`
- **company:** null
- **title:** null
- **confidence:** (not stored)
- **relationship_to_me:** Saved contact with single-letter nickname; personal contact suggesting close familiarity.
- **reasoning:** Contact saved as 'V' (single letter) indicates personal relationship with informal naming convention; no professional activity recorded.

