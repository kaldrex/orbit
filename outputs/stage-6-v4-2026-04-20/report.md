# Stage 6 V4 — LID-aware Enrichment Report

**Verdict:** `STAGE6_V4_PASS`
**Run started:** 2026-04-20T11:39:16.107Z
**Wall-clock:** 811.5s

## Phase timings
- Phase A: 1.8s
- Phase B: 1.0s
- Phase C: 778.5s
- Phase D: 14.6s
- Phase E: 12.5s

## Target set
- Target persons (category='other', excl Umayr+Ramon): **1470**
- Contexts gathered: 1470
- Enriched: 1470
- Failed LLM batches: 0
- Observations written: 1470
- Observations inserted: 1470
- Observations deduped: 0
- POST failed batches: 0

## Context coverage (LID-bridge effect)
- Persons with WA DMs: 79
- Persons with WA groups: 455
- Persons with WA group messages: 115
- Persons with Gmail threads: 76
- Persons with zero signal: 897
- Persons with at least one LID bridged: 546

## Token usage
- Input tokens: 3,92,429
- Output tokens: 2,23,066
- Cache write tokens: 0
- Cache read tokens: 0
- **Prompt cache hit rate: 0.0%** (Fix #3)
- **Estimated cost: $4.523**

## Before/after category distribution
### Before
- other: 1470
- friend: 59
- founder: 19
- fellow: 16
- sponsor: 14
- team: 11
- community: 9
- media: 4

### After
- other: 1055
- fellow: 282
- friend: 101
- community: 90
- founder: 31
- sponsor: 20
- team: 18
- media: 5

## Sample audit (15 cards)
| person_id | category | relationship_to_me (truncated) | company | title |
|-----------|----------|-------------------------------|---------|-------|
| 164d56aa | fellow | Peer in the 'ARTIFICIAL INTELLIGENCE FALL 2024' and 'TOEFL PREP' groups, suggesting a co-a | - | - |
| 1befbcd0 | community | Member of the 'Code Samaaj - Talent' group, a developer/tech community that Sanchay is par | - | - |
| 582b91da | fellow | Member of the 'USA Fall 2024' group shared with Sanchay, suggesting a peer from a cohort o | - | - |
| 5ade28cc | fellow | College peer from SAKEC's AI & DS batch (2024 passout) also active in the Hack2skill hacka | - | - |
| 161e9371 | fellow | Classmate or college peer from SAKEC's 2024-passout AI & DS batch; also a co-member of the | - | - |
| 906bc5b4 | fellow | Member of the 'USA Fall 2024' group alongside Sanchay, suggesting a peer in a cohort of In | - | - |
| 0f5c8779 | community | PhD holder active in the Programming and Machine Learning Training groups who promotes a f | - | Ph.D. |
| 0bd2e7d7 | community | Active participant in the AI Video-Gen News and General Channel groups who shares AI video | - | - |
| 303ab096 | fellow | Member of both '1 - USA Fall 2024 🇺🇸🇮🇳' and '2 - USA Fall 2024 🇺🇸🇮🇳' groups shared | - | - |
| 858dbbec | fellow | College peer from SAKEC (Shah and Anchor Kutchhi Engineering College) connected through th | - | - |
| 2d1bf9ee | team | Member of the 'CypherSOL IT Team' WhatsApp group shared with Sanchay, indicating a colleag | CypherSOL | - |
| 305e2931 | fellow | College peer from SAKEC's 2023-24 alumni batch, active in blockchain, AI & DS, and coding  | SAKEC | Engineer |
| 23a04316 | fellow | Cohort peer from the 'USA Fall 2024' group, likely a fellow Indian student or professional | - | - |
| 59d9c94a | friend | Contact shared in the 'The Empire State November 2023' group with Sanchay, suggesting a tr | - | - |
| 9e90197b | community | Program coordinator at Samagra Governance's Code for GovTech (C4GT) initiative who emailed | Samagra Governance | Program Team, C4GT |

## Umayr canary
- ok: true
- detail: {"ok":true,"diff":[]}

## Notes
- Before dist: [{"cat":"other","n":1470},{"cat":"friend","n":59},{"cat":"founder","n":19},{"cat":"fellow","n":16},{"cat":"sponsor","n":14},{"cat":"team","n":11},{"cat":"community","n":9},{"cat":"media","n":4}]
- Context stats: {"withDms":79,"withGroups":455,"withGroupMsgs":115,"withGmail":76,"empty":897,"withLid":546}
- Pre-D quality sample: 0/50 vague (0%).
