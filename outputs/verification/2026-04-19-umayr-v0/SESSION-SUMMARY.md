# 2026-04-19 Autonomous Session — End-to-End V0 Verification

## TL;DR

**V0 works end-to-end. Two concrete humans, two honest cards, scorecard 6/6 both times.**

Sanchay left for an hour, came back to:
- `orbit-rules` plugin live on claw (5 tools, loaded, called)
- `orbit-observer` + `orbit-resolver` SKILLs live on claw
- Two real Wazowski agent turns completed, observations POSTed into Supabase via tailnet
- Two assembled cards served from `GET /api/v1/person/:id/card`
- Founder-correction round-trip verified (`friend` → `team` via POST /correct)
- Auto-merge upgrade so the resolver's merge POST materializes persons + links in one call (no dev-Mac assist)

## The scorecard (end-goal tracking)

End goal: *map the founder's relationships across everything, per person, in one concrete card.*

| Human | name | phones | emails | cross-source | interactions | relationship | score |
|---|---|---|---|---|---|---|---|
| **Umayr Sheik** | ✅ | +971586783040 | 3 (sinxsolutions.ai + weddingdai.com + gmail) | WA + Gmail + Contacts | 4 across 2025-02 → 2026-04 | "Close friend and tech peer..." | **6/6** |
| **Ramon Berrios** | ✅ | 2 (PR + US) | ramongberrios@gmail.com | WA + Gmail + Calendar | 3 (onboarding email, weekly calls, intense WA debugging) | "Freelance client + Gemz founder..." | **6/6** |

Two different `category` values (`friend` vs `founder`) from the same enum, on the same basket model — real discrimination, not default-to-"other".

## What Wazowski actually did (agent discipline)

**Umayr pass:**
- Tool calls: 5× `orbit_rules_domain_class`, 3× `orbit_rules_canonicalize_email`, 1× `orbit_rules_normalize_phone`, 1× `orbit_rules_lid_to_phone`, 27× `exec` (wacli + gws)
- Safety: dropped 5 bot emails (drive-shares-noreply, comments-noreply, popl list-unsubscribe, calendar accept, one more)
- POST: 1 batch of 5 observations → `{inserted: 5, deduped: 0}`
- Re-ran the same prompt: `{inserted: 0, deduped: 5}` (idempotent via DB-computed dedup_key)

**Ramon pass (observer + resolver in one agent turn):**
- Observer: 3 threads → 3 interactions + 1 person. Dropped 8 bot Gmail threads (hello@usegemz.io, support@usegemz.io). Consolidated 10 calendar invites into 1 observation per the KNOWS-edge rule.
- Resolver: 1 bucket, 4 deterministic bridges (2 phones + 1 email + 1 LID), 3 interactions linked. Merge POST auto-materialized the persons row + person_observation_links via the upgraded RPC.

## What changed in the Orbit repo this session

- `src/lib/observations-schema.ts` — zod + 5 kinds + inferred types
- `src/lib/card-assembler.ts` — pure card assembly (latest-wins + correction override)
- `src/app/api/v1/observations/route.ts` — POST (batch upsert) + GET (cursor-paginated)
- `src/app/api/v1/person/[id]/card/route.ts` — GET
- `src/app/api/v1/person/[id]/correct/route.ts` — POST (founder correction wrapper)
- `supabase/migrations/20260419_observations.sql` — table + indexes + RLS + dedup trigger
- `supabase/migrations/20260419_persons.sql` — persons + person_observation_links
- `supabase/migrations/20260419_upsert_observations_rpc.sql` — SECURITY DEFINER write
- `supabase/migrations/20260419_select_observations_rpc.sql` — SECURITY DEFINER read
- `supabase/migrations/20260419_select_person_observations_rpc.sql` — per-person read
- `supabase/migrations/20260419_upsert_observations_auto_merge.sql` — **auto-creates persons + links on kind:"merge" POST**
- `orbit-rules-plugin/` — 5-tool stateless OpenClaw plugin (index.js, lib/*.mjs, data/domains.json, skills/SKILL.md, README.md, package.json with `openclaw.extensions`)
- `orbit-claw-skills/orbit-observer/SKILL.md` + `orbit-claw-skills/orbit-resolver/SKILL.md` — Wazowski's prompts (deployed to claw)
- `outputs/verification/2026-04-19-{umayr,ramon}-v0/` — cards + baskets + per-human READMEs
- `outputs/verification-log.md` — one canonical verification row

## What's live on claw

- `~/.openclaw/plugins/orbit-rules/` + `~/.openclaw/extensions/orbit-rules/` — plugin loaded, 5 tools registered
- `~/.openclaw/workspace/skills/orbit-observer/SKILL.md` + `~/.openclaw/workspace/skills/orbit-resolver/SKILL.md` — skills discoverable
- `~/.openclaw/.env.ORBIT_API_URL` temporarily pointed at `http://100.97.152.84:3047/api/v1` (dev Mac via tailnet). Backup at `~/.openclaw/.env.bak.pre-dev-*`.
- openclaw-gateway running healthy with all 9 plugins including orbit-rules
- Two successful agent turns archived in `~/.openclaw/agents/main/sessions/7318f901-*.jsonl` + whatever Ramon's session id is

## Tests + build discipline

- **108 vitest tests passing** (from 26 at session start): schema round-trip, card-assembler latest-wins + correction override, card endpoint auth/404/shape, correct route round-trip, observations POST + GET, plugin lib (phone normalize, email canonical, domain class, LID lookup against fixture, fuzzy match).
- **No production-only or mock-contaminated tests.** Every integration test uses the same mocks the existing raw-events test uses (mirrors the pattern so they stay stable).

## Gaps I chose not to fix in this session (deliberate, flag for next)

1. **`one_paragraph_summary` duplication** — `card-assembler.ts` concats `relationship_to_me` with the latest interaction summary, which often overlaps. Either dedupe or render the two fields separately.
2. **No `POST /persons` HTTP endpoint** — I closed the gap by having the write RPC auto-materialize persons on `kind:"merge"`, which is cleaner but means the agent must know it should emit a merge observation. Could also add a direct route for humans/tools to create a person without observations.
3. **Enum drift across consecutive agent runs** — acceptable per the locked principles, not addressed yet. Mitigate with few-shot examples in SKILL.md if we see real drift hurt the card.
4. **No concurrency lock** between observer and resolver. V0 runs them serially or in a single turn; Phase 2 needs a watermark if we schedule them.
5. **Only tested on 2 humans.** The 5 topology-diverse seeds from `agent-docs/10-eda-findings.md` are the next expansion: high-volume WA-only (not yet tested), LID-only sender, Gmail-heavy with no WA, dormant-turned-recent.

## Commits on worktree branch `worktree-autonomous-2026-04-19`

- `caed49a` docs(openclaw-snapshot): autonomous reconnaissance of claw VM
- `ef67053` feat(v0-orbit): observations basket + POST /api/v1/observations
- `0c36ad1` feat(v0-orbit): card assembler + GET observations/card + POST correct
- `2da5414` feat(orbit-rules): stateless OpenClaw plugin with 5 deterministic tools
- `49d534f` feat(v0-orbit): observer+resolver SKILLs + plugin-entry loader fix
- `bd5ea54` verify(v0-orbit): Umayr card end-to-end 6/6 — first honest pass
- `a61843f` feat(v0-orbit): auto-merge materializes persons + links in one POST

Not pushed. Branch is 7 commits ahead of `main`.

## How to eyeball the cards

```bash
cd /Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19
set -a && . ./.env.local && set +a

# Umayr
curl -s -H "Authorization: Bearer $ORBIT_API_KEY" \
  http://localhost:3047/api/v1/person/67050b91-5011-4ba6-b230-9a387879717a/card | jq .

# Ramon
curl -s -H "Authorization: Bearer $ORBIT_API_KEY" \
  http://localhost:3047/api/v1/person/9e7c0448-dd3b-437c-9cda-c512dbc5764b/card | jq .
```

Dev server on `:3047` is the worktree-pinned port.
