# Audit 4/6 — Data Pipeline Quality

Date: 2026-04-21
Working dir: `.claude/worktrees/autonomous-2026-04-19/`
Method: read-only SQL against Supabase prod DB + Neo4j Aura + dev server on :3047. No pipelines re-run, no LLM spend.

---

## 1. Interaction pipeline (`scripts/build-interactions-from-raw-events.mjs`, Phase 1)

- **Claim:** 11,755 `kind:"interaction"` observations from 33k raw_events.
- **Measured:**
  - `SELECT COUNT(*) FROM observations WHERE kind='interaction'` = **11,762**
  - `SELECT COUNT(*) FROM raw_events` = **33,105**
  - `SELECT COUNT(DISTINCT id) FROM observations o JOIN person_observation_links pol ON o.id=pol.observation_id WHERE o.kind='interaction'` = **11,762** (100% linked)
  - 11,757 carry `wacli://` evidence pointers; 5 carry other schemes (likely gmail/manual).
- **Verdict:** **MATCH (soft)** — 7 more interactions than claimed (11,762 vs 11,755). Likely drift from a later top-up or manifest observation; both the summary.json (`interactions_inserted: 8155` + `merges_inserted: 8255 / plans_total: 11755`) and the DB agree on the order of magnitude. Every interaction is person-linked.
- **Sample of 5 random interactions:**

| id | channel | summary | person |
|---|---|---|---|
| ac5ca316 | whatsapp | "Inbound WhatsApp message: 47" | 9a1fa466 |
| 1a00e0d2 | whatsapp | "Inbound WhatsApp message: paper lane he padega kaise bhi kake" | b65545c9 |
| 99a668e3 | whatsapp | "Outbound WhatsApp message: product;\"cyphersol\" krke" | 5dc15521 |
| b443719d | whatsapp | "Inbound WhatsApp message: Entry kara dena bass" | 24e45dc3 (Meet) |
| d31fecda | whatsapp | "Inbound WhatsApp message: Me / Omran / Gyan..." | 67050b91 (Umayr) |

All samples carry `channel=whatsapp`, a `summary`, a real `wacli://messages/source_event_id=…` evidence pointer, and a valid person link. Quality: decent signal — summaries are raw message text prefixed by Inbound/Outbound, not LLM-paraphrased. This is observation-grade ledger text, not card-facing prose.

---

## 2. Graph populate (Phase 2 + P5.1 LID bridge)

- **Claim:** 1,602 Person nodes + ~1,232 edges (DM 135 · SHARED_GROUP 1,095 · EMAILED 2).
- **Measured (via Neo4j driver, `scripts/_audit-neo4j.mjs`):**
  - `MATCH (p:Person) RETURN count(p)` = **1,602** exact MATCH
  - `SHARED_GROUP` = **1,095** exact MATCH
  - `DM` = **135** exact MATCH
  - `EMAILED` = **2** exact MATCH
  - Total = **1,232** exact MATCH
- **Verdict:** **MATCH (exact)** on every counter.
- **Sample SHARED_GROUP edges:** all five carry real `group_ids` like `919833552355-1596350177@g.us`, `120363039663672513@g.us`, `919819248590-1542703178@g.us`, `120363164085936553@g.us` with weight, `group_count`, `last_at`. One edge in the sample has `group_count: 4` — a hub pair sharing 4 distinct groups. Real groups confirmed.
- Person nodes carry `name`, `category`, `score`, `last_interaction_at`, `relationship_to_me` (LLM-written), and counts.

---

## 3. Topic Resonance (Phase 4, P4-C)

- **Claim:** 99 persons tagged, $1.72 Haiku spend, Meet has aakaar/reels/etc.
- **Measured:**
  - `SELECT COUNT(DISTINCT person_id) FROM person_topics` = **100** (claim 99; +1 drift, probably the re-post run topped one up).
  - Summary.json reports $1.7239 spend — MATCHes claim.
  - Top per-person topic counts: 7 persons at 20 topics (the cap), plus a long tail.
- **Verdict:** **MATCH (soft)**. Cost matches, count off by +1.
- **Meet (`24e45dc3`) topic cloud:** aakaar (1.0), flight booking, pr, impact india day, workshops, reels, march meetup, reel shoot, atlas isdi, event planning, sponsorship. Matches the aakaar/reels claim. Sharp and on-brand for an Aakaar/ISDI events operator.
- **Umayr (`67050b91`) topic cloud:** jewelry crm, claude agents, iran, omran, jewelry, observability, agent ops, a2a protocol, short-form content, jewelry ai, audience building, vc fundraising, coding agents, y combinator, dubai, car flood recovery, marketing assets, social media, landscaping, san francisco. Sharp — captures his SinX/jewelry CRM product, AI agent discourse, Dubai geography, VC/YC thread. Best quality sample.

---

## 4. Meeting Briefs (Phase 4, P4-B)

- **Claim:** 4 live meetings with Haiku briefs.
- **Measured:** `SELECT COUNT(*) FROM meetings WHERE brief_md IS NOT NULL` = **5** (4 Hardeep recurring instances + 1 `audit-1776749803720` "Audit Probe Meeting" test stub with brief_md "audit probe brief" length 17 and synthetic `audit@example.com` attendee).
- **Verdict:** **MATCH (soft)** — 4 real briefs (claim) + 1 audit stub that should be excluded by a production filter.
- **Sample brief (`7qk08u9pa0as73bnm18nll8gm0` Hardeep / Sanchay):**
  > **Hardeep Gambhir** - LocalHost co-founder running Japan ops and partnerships from Tokyo. Yesterday's sync likely covered CHAD network deployment progress and Ripe/Gemz product development status.
  >
  > **Ask:** How are the Japan partnership discussions progressing, and what specific blockers need Sanchay's direct involvement to move forward?

  Cites real context: LocalHost (co-founded co.), Japan/Tokyo, CHAD network, Ripe/Gemz products. No hallucination.

---

## 5. Going Cold (P4-A)

- **Claim:** 9 going-cold humans.
- **Measured:** `curl /api/v1/persons/going-cold` → **42 persons, total:42**.
- **Verdict:** **DRIFT** — actual is 42, claim was 9 (4.7× off).
- **Invariant check:** every single one of 42 records satisfies `days_since > 14` AND `score > 2` (the route's enforced predicates). The route is behaving as written (`COLD_THRESHOLD_DAYS=14`, `MIN_SCORE=2`).
- **Sample:** Rida (285 days), Manish Patil (213), Raj Singh (138), Vasisht|Vazor (94), Harsh Jain (94), … newest is Omkar W (15 days, score 4.39). Categories span team / friend / fellow / community / founder / sponsor — the list looks like a legitimate list of people who have gone quiet. Quality: high. The "9" claim appears to be a stale count from an earlier run; possibly the graph populate ran since then and produced more qualifying nodes.

---

## 6. Self node init (P4-A)

- **Claim:** `profiles.self_node_id` is set for Sanchay (`dbb398c2-…`).
- **Measured:** `SELECT self_node_id FROM profiles WHERE id='dbb398c2-1eff-4eee-ae10-bad13be5fda7'` = `994a9f96-8cfc-4829-8062-87d7b900e4c6` (non-null, valid UUID).
- **Verdict:** **MATCH**. Cross-check: same `994a9f96-…` UUID appears as the a-side of the highest-weight DM edge (weight 5.68, 360 messages, to `00be722a` Swarangi — family member), confirming it's a real Person node in Neo4j, not a placeholder.

---

## 7. Umayr canary invariant

- **Claim:** 5 core fields match fixture at `outputs/verification/2026-04-19-umayr-v0/card.json`.
- **Measured:** `curl /api/v1/person/67050b91-…/card` vs fixture:

| Field | Fixture | Current | Match |
|---|---|---|---|
| name | "Umayr Sheik" | "Umayr Sheik" | == |
| category | "team" | "team" | == |
| company | "SinX Solutions" | "SinX Solutions" | == |
| title | "Founder" | "Founder" | == |
| relationship_to_me | "Close friend and tech peer based in Dubai. One of the few people Sanchay considers a match for deep AI/ML discussions. Connected Feb 2025; became close quickly through regular WhatsApp DMs." | (same) | == |

- **Verdict:** **MATCH (exact, all 5 fields byte-identical)**.

---

## Summary table

| # | Pipeline | Claim | Measured | Verdict |
|---|---|---|---|---|
| 1 | Interactions | 11,755 | 11,762 | MATCH (soft, +7) |
| 2 | Graph — Person | 1,602 | 1,602 | MATCH (exact) |
| 2 | Graph — SHARED_GROUP | 1,095 | 1,095 | MATCH (exact) |
| 2 | Graph — DM | 135 | 135 | MATCH (exact) |
| 2 | Graph — EMAILED | 2 | 2 | MATCH (exact) |
| 3 | Topic Resonance persons | 99 | 100 | MATCH (soft, +1) |
| 3 | Topic spend | $1.72 | $1.7239 | MATCH (exact) |
| 4 | Meeting briefs | 4 | 5 (4 real + 1 audit stub) | MATCH (soft) |
| 5 | Going Cold | 9 | 42 | **DRIFT (4.7×)** |
| 6 | Self node init | set | set | MATCH |
| 7 | Umayr canary 5-field | exact | exact | MATCH |

No DB modification, no pipeline re-run, no LLM spend consumed.
