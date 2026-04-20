# 13 · Multi-tenant Onboarding

> How to add a new founder to Orbit. Answers: *"If my friend Deep wants the same system for himself, what do I do?"*
>
> **Status (2026-04-20):** Design-only. RLS is wired, `ORBIT_SELF_EMAIL`/`ORBIT_SELF_PHONE` hardcode-removal shipped in the 2026-04-20 cleanup. Everything else (plugin npm-distribution, API-key-minting UI, second-founder dogfood) is blocked on V0 dogfood proving out for Sanchay first (`feedback_dogfood_before_generalize.md`).

## Summary

Orbit is designed multi-tenant from day one: **one Orbit deployment serves N founders, each isolated in their own Supabase `user_id` scope via RLS**. Each founder runs their OWN OpenClaw + wacli + gws on their OWN machine. Orbit holds the relationship memory; the founder's machine does the channel I/O. Code is ~95% generic; one hardcode remains and is a 5-minute fix.

## Shared vs per-founder

| Shared (one instance total) | Per-founder |
|---|---|
| Orbit Next.js app (Vercel) | OpenClaw agent runtime on their machine |
| Supabase Postgres (RLS scoped) | wacli auth'd to their WhatsApp |
| Neo4j (if re-enabled) | gws auth'd to their Gmail/Contacts/Calendar |
| orbit-rules plugin source | Their own Orbit API key |
| orbit-cli plugin source | Their own `~/.openclaw/.env` |
| orbit-observer + orbit-resolver SKILLs | Their own manifest + cards in DB |

## Onboarding steps for a new founder (call them Deep)

### Step 1 — Orbit account (Deep-facing, 2 min)
Deep signs up at `https://orbit.yourdomain.com/signup` → email + password → Supabase creates `auth.users` row with Deep's `user_id`. Via dashboard, generate an API key tied to that user_id (format `orb_live_deep_xxxxx`). Admin stores it; Deep receives it.

### Step 2 — OpenClaw install (Deep-facing, ~30 min)
Deep installs OpenClaw on his laptop (or a personal VM). Install script: curl + systemctl. Mostly unattended.

### Step 3 — Channel authentication (Deep-facing, 15 min)
- `wacli auth` → Deep scans the QR code with his WhatsApp. `~/.wacli/wacli.db` populates as he uses WhatsApp
- `gws auth` → Google OAuth flow for Gmail, Contacts, Calendar. Tokens stored in `~/.gws/`

### Step 4 — Install Orbit plugins (admin, ~10 min)
```
ssh deep 'cd ~/.openclaw/plugins && git clone https://github.com/kaldrex/orbit.git orbit-src'
ssh deep 'cp -r orbit-src/orbit-rules-plugin ~/.openclaw/plugins/orbit-rules'
ssh deep 'cp -r orbit-src/orbit-cli-plugin   ~/.openclaw/plugins/orbit-cli'
ssh deep 'cd ~/.openclaw/plugins/orbit-rules && npm install --omit=dev && openclaw plugins install'
ssh deep 'cd ~/.openclaw/plugins/orbit-cli   && npm install --omit=dev && openclaw plugins install'
```

Future: publish the plugins as versioned npm packages, skip the git-clone.

### Step 5 — Configure env (admin, 2 min)
Deep's `~/.openclaw/.env`:
```
ORBIT_API_URL=https://orbit.yourdomain.com/api/v1
ORBIT_API_KEY=orb_live_deep_xxxxx
ORBIT_SELF_EMAIL=deep@yourdomain.com
ORBIT_SELF_PHONE=+1xxxxxxxxxx
```

`ORBIT_SELF_EMAIL` and `ORBIT_SELF_PHONE` are **new env vars** that replace the hardcoded self-exclusion. See "Code changes required" below.

### Step 6 — Install skills (admin, 5 min)
```
rsync orbit-claw-skills/orbit-observer/  deep:~/.openclaw/workspace/skills/orbit-observer/
rsync orbit-claw-skills/orbit-resolver/  deep:~/.openclaw/workspace/skills/orbit-resolver/
```

Restart gateway: `ssh deep 'systemctl --user restart openclaw-gateway.service'`.

### Step 7 — First observer run (Deep or admin, 5 min)
Pick a seed from Deep's data (any person he's DM'd). Trigger:
```
ssh deep 'openclaw agent --agent main --message "orbit-observer scan --seed <deep-contact>"'
```
Wazowski-Deep reads Deep's data, applies rules, emits observations via `orbit_observation_emit` → posts to Orbit → first card lands under Deep's user_id. Verify: `orbit_person_get` on the new UUID returns a valid card.

### Step 8 — Bulk ingest (admin, ~30 min)
```
ssh deep 'cd ~/.openclaw/plugins/orbit-rules && node manifest-gen.mjs > /tmp/deep-manifest.ndjson'
scp deep:/tmp/deep-manifest.ndjson ./deep-manifest.ndjson
node scripts/manifest-to-observations.mjs < deep-manifest.ndjson > deep-observations.ndjson
ssh deep 'orbit_observation_bulk --file /tmp/deep-observations.ndjson'
```
Deep's entire network now lives in Orbit's DB, scoped to his user_id.

### Step 9 — LLM enrichment (Deep-paid, half day)
Wazowski-Deep batches through Deep's humans 20 at a time, filling in category / relationship_to_me / topic / sentiment. Cost paid from Deep's OpenClaw LLM budget (~$5 total at V0 scale).

## Code changes required

### ~~One hardcode to remove~~ — **DONE 2026-04-20**

`outputs/manifest-hypothesis-2026-04-19/manifest-gen.mjs` (+ claw mirror) read `ORBIT_SELF_EMAIL` / `ORBIT_SELF_PHONE` from env and refuse to run if unset (fail-fast). See [14-cleanup-2026-04-20.md](./14-cleanup-2026-04-20.md) §Phase B5. No remaining hardcodes.

### API key issuance UI

Currently ad-hoc insertion into `api_keys` table. For production: admin page in Orbit dashboard → button to mint, scope to user_id, set `name` + `expires_at`.

### No schema changes

Supabase `observations`, `persons`, `person_observation_links`, `blocklist` tables all have RLS `USING (user_id = auth.uid())`. Deep's API key maps to Deep's user_id; his writes and reads auto-scope. No cross-contamination possible at the DB layer.

## Privacy and data isolation

- Each founder's observations, persons, blocklist entries are scoped by `user_id`
- API key validates to exactly one `user_id`; all writes/reads scope to that
- Founders cannot see each other's data — enforced by Supabase RLS, not application logic
- Observability/logs: scrub PII from server logs; use per-user buckets if we add log aggregation

## Cost per founder

| Component | Cost / founder / month |
|---|---|
| Supabase | ~$0 (shared Pro project, <$0.10 marginal) |
| Vercel (Orbit app) | ~$0 (shared, well under included quota) |
| Anthropic — enrichment | ~$5 initial + ~$2/month steady-state |
| Anthropic — OpenClaw agent runtime | ~$20-50/month depending on activity, paid by founder |

**V0 scale assumption:** ~6-10k humans per founder. Costs scale roughly linearly with network size.

## Time to onboard Deep, end-to-end

- Orbit signup + key: 2 min
- OpenClaw install + channel auths: 45 min (mostly Deep's side)
- Plugins + skills install: 15 min
- First observer run: 5 min
- Bulk ingest: 30 min
- LLM enrichment: half day (overnight)

**Total: ~1 working day from signup to "live, enriched map."**

## Open questions for revisit

1. Shared blocklist across founders (opt-in) — see [12-junk-filtering-system.md](./12-junk-filtering-system.md) "Future"
2. Does each founder get their own `orbit-cli` plugin install or a shared one via symlink? (npm-registry path solves this)
3. Auditing: should admin see aggregate telemetry (tokens used, observations emitted per founder) without seeing content? RLS already hides content; aggregate counts would need a materialized view.
4. Self-hosted option — some founders may want to run Orbit on their own Supabase project. Requires a "bring your own DB" config path.
5. Billing — who pays Anthropic, is enrichment metered per founder?
