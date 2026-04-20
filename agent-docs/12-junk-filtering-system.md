# 12 · Junk Filtering System

> How Orbit keeps bots, spam, forwarded-chain artifacts, junk WhatsApp groups, and other noise out of the relationship map — via deterministic rules, agent-authored blocklist entries, and explicit human curation.
>
> **Status (2026-04-20):** Layer 1 (deterministic rules) **shipped** — 10 modules in `orbit-rules-plugin/lib/` including `safety.mjs`, `group-junk.mjs`, `forwarded.mjs`, `name.mjs`, applied at both observer emission and bulk transform time. Layer 3 (heuristics at generation) partially shipped — mega-lurker + broadcast-ratio + commercial-keyword heuristics live in `group-junk.mjs` as annotations. Layer 2 (agent-mutable blocklist table + CLI verbs + API routes) **still future** — design below is forward-looking.

## Goal

A person-map of ~6,800 humans with zero bots pretending to be people, zero marketing groups polluting `groups` fields, zero "digital ocean"-style forwarded-chain artifacts. The system must be correct **at generation time** (not cleaned up later) and must **self-improve** when Wazowski or Sanchay sees new junk.

## Three layers of defense

### Layer 1 — Deterministic rules (code)

Shipped in `orbit-rules-plugin/`, applied at every manifest generation and every observer run. Covers:
- Bot email localparts (`noreply|info|support|account-info|receipts|billing-info|statements|alerts|notify|mailer|*-noreply`)
- List-Unsubscribe / Precedence:bulk headers
- 42-vendor SaaS domain blocklist
- Forwarded-chain name stripping (vendor name on non-vendor domain)
- Phone-as-name, email-as-name, empty name rejection
- Generic first-name guard (blocks single-token collisions on common names)

Changes require a plugin redeploy + tests. Today: 329 tests green across 19 files (the rule-plugin sub-suite includes `orbit-rules-plugin.test.mjs`, `...-safety.test.mjs`, `...-name.test.mjs`, `...-group-junk.test.mjs`).

### Layer 2 — Agent-mutable blocklist (Supabase table)

A live table that manifest-gen, observer, and resolver all consult at runtime. Mutable by three agents: Sanchay (manual), Wazowski (autonomous), or the generator itself (heuristic).

### Layer 3 — Heuristics at generation (self-writing)

The manifest generator auto-detects new junk patterns during build and writes new blocklist entries. Sanchay reviews weekly.

## Blocklist schema

```sql
CREATE TABLE blocklist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) NOT NULL,
  kind text NOT NULL,
  -- 'email' | 'email_pattern' | 'domain' | 'name' | 'name_pattern'
  -- | 'group_jid' | 'group_name_pattern'
  pattern text NOT NULL,
  reason text NOT NULL,
  source text NOT NULL,  -- 'manual' | 'agent' | 'heuristic'
  added_by text NOT NULL,  -- email | 'wazowski' | heuristic name
  confidence numeric NOT NULL,  -- 0.0-1.0
  active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE blocklist ENABLE ROW LEVEL SECURITY;
CREATE POLICY blocklist_user_scope ON blocklist
  USING (user_id = auth.uid());
CREATE INDEX blocklist_lookup ON blocklist (user_id, kind, active);
```

## Write paths

### Manual — Sanchay via CLI

```
orbit block-email account-info@skydo.com --reason "billing bot"
orbit block-name "digital ocean" --reason "forwarded-chain artifact"
orbit block-group 120363xxxxx@g.us --reason "crypto spam channel"
orbit unblock-email account-info@skydo.com
orbit blocklist list [--kind=... | --source=...]
```

Each verb POSTs to `/api/v1/blocklist` (new route), scoped by authenticated user_id.

### Agent-autonomous — Wazowski

New orbit-cli tools the observer SKILL can call when confident:
- `orbit_block_email({email, reason, confidence})` — when he sees a new bot pattern
- `orbit_block_group({group_jid, reason, confidence})` — when a group looks like a broadcast channel
- `orbit_block_name({name, reason, confidence})` — when a forwarded-chain artifact surfaces

Rules: only add when `confidence ≥ 0.9`. Always log `reason` with evidence. Sanchay reviews via `orbit blocklist list --source=agent` and can demote (set `active=false`) anything he disagrees with.

### Heuristic — manifest-gen self-writes

After union-find, the generator scans for patterns and writes entries:

**Group heuristics (the gap we have today):**
- Member count > 200 AND Sanchay's outbound message count = 0 → `group_jid` block, `added_by='mega-lurker'`, `confidence=0.85`
- Broadcast ratio: single sender > 80% of messages → `group_jid` block, `added_by='broadcast-detector'`, `confidence=0.9`
- Group name matches commercial keyword regex (`sale|deal|offer|crypto|giveaway|coupon|promo|discount`) → `group_name_pattern`, `added_by='commercial-keyword'`, `confidence=0.8`

**Email heuristics:**
- Sender sends >50 messages, <5 personalized, all from same template shape → `email` block, `added_by='template-detector'`

## Read paths

**manifest-gen** — on startup: `SELECT * FROM blocklist WHERE user_id = $1 AND active = true`. Build in-memory indexes (sets for exact, regex arrays for patterns). During generation, every bucket checks against indexes before being emitted.

**observer SKILL** — new step before emitting: call `orbit_blocklist_get()` once per run, apply same checks.

**Orbit API** — before POST accept, cross-reference. If matched, reject with `409 Conflict` and echo the matching entry so the caller knows.

## Lifecycle

1. Manifest runs → heuristics flag mega-groups + commercial-keyword groups → blocklist entries written (source=heuristic, confidence 0.8-0.9)
2. Wazowski occasionally adds entries during observer runs (source=agent, confidence ≥ 0.9)
3. Sanchay reviews weekly: `orbit blocklist list --source=heuristic --confidence-lt=0.95` → promotes (set confidence=1.0), demotes (active=false), or leaves alone
4. Sanchay adds manual entries via CLI whenever he spots junk (source=manual, confidence=1.0)

## Testing strategy

- Unit tests per kind (email/name/domain/group_jid/pattern) with real failing data from prior recons
- Integration test: ingest a synthetic 500-member WhatsApp group with 1 sender → confirm heuristic blocks it, confirm group doesn't appear in any card
- Regression: sample 20 random buckets post-fix, assert 0 junk in sample

## Future

- ML-based junk detection (post-V0)
- Shared blocklist across founders (opt-in, post multi-tenant launch)
- Per-person hide (keep observations, suppress card) — needs design
- Blocklist audit log (who/when/why on every write)

## Open questions

1. Should the agent's autonomous blocks require Sanchay approval within 7 days, else revert? (safety against LLM drift)
2. Should heuristic entries auto-expire if they don't match anything for 90 days?
3. Do we version the blocklist schema so old manifests can be re-generated against the blocklist state at that time?
