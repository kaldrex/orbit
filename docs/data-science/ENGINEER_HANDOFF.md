# Orbit Connector Framework — Engineer Handoff

**Branch**: `claude/fervent-banach` (in the localhost repo at `~/.claude/worktrees/fervent-banach/`)
**Orbit repo**: `~/Documents/projects/personal/orbit/` (main branch, 10 commits ahead)
**Date**: 2026-04-16
**Status**: Algorithms validated, plugin code written, API rewritten. Needs deployment + Vercel debugging.

---

## What's in This Branch (Experiment Repo)

All data science work lives in `orbit-experiment/`:

| File | What it is |
|---|---|
| `experiment.py` | Full experiment: data loading, identity resolution, scoring, KNOWS edges, train/test validation |
| `platform_rules.py` | Platform-specific cleaning rules (Calendar, WhatsApp, Gmail, Slack, Linear) |
| `intelligence_layer.py` | **Validated algorithms**: ScoringEngine, CanonicalNameResolver, DecayEngine |
| `first_time_ingestion.py` | First-time ingestion pipeline: pull → clean → resolve → classify → ingest |
| `poc_connector.py` | Performance PoC: 0.043ms/msg, 23K msg/sec validated on Wazowski |
| `REPORT.md` | Experiment results with all metrics |
| `BRAINSTORM-intelligence-redesign.md` | **Future design**: rules-as-evidence architecture (not yet implemented) |
| `data/raw/` | Real data pulled from Wazowski (WhatsApp, Calendar, Gmail, Slack, Linear) |
| `docs/superpowers/specs/` | Design spec for the connector framework |
| `docs/superpowers/plans/` | Implementation plan (9 tasks) |

---

## What's in the Orbit Repo (Main Branch)

10 commits on `main` that are pushed to GitHub and partially deployed to Vercel.

### API Changes (3 files modified)

| File | Change |
|---|---|
| `src/app/api/v1/ingest/route.ts` | Rewritten: `waitUntil` + chunked processing. Returns immediately, writes Neo4j in background. Deduplicates persons. Backward-compatible response format (both `accepted` and `stats` fields). |
| `src/lib/neo4j.ts` | Added 4 batch helpers: `batchUpsertPersons`, `batchResolveParticipants`, `batchCreateInteractions`, `batchMergeKnows`. Each uses UNWIND for 1 round-trip per 20 items instead of 1 per item. |
| `vercel.json` | Created: `fluid: true`, `maxDuration: 60` for ingest route. |

### Plugin (23 files created in `packages/orbit-plugin/`)

```
packages/orbit-plugin/
├── package.json                    # ESM package, optional better-sqlite3 dep
├── openclaw.plugin.json            # OpenClaw manifest, ORBIT_API_KEY config
├── index.js                        # Plugin entry: register(api) pattern
│                                   #   - 7 tools (4 read, 2 write, 1 status)
│                                   #   - Async connector lifecycle
│                                   #   - Orphan filter on orbit_ingest
│                                   #   - Category normalization
├── SKILL.md                        # Agent instructions: startup, tools, rules, schema
├── lib/
│   ├── orbit-client.js             # HTTP client for Orbit API (get/post/patch)
│   ├── identity-cache.js           # Cross-source identity resolution
│   │                               #   Loads wacli SQLite contacts + LID mapping
│   │                               #   resolveJid(), resolveEmail(), displayName()
│   ├── signal-buffer.js            # Batched push to Orbit API
│   │                               #   30s flush interval, 5-min dedup, max 50/flush
│   │                               #   Retry with backoff, graceful shutdown
│   └── connector-registry.js       # Discovers + orchestrates connectors
│                                   #   Scans connectors/ for manifest.json
│                                   #   Starts batch polls, routes webhook events
└── connectors/
    ├── base-connector.js           # Interface: isAvailable, poll, processEvent
    ├── whatsapp/                   # Real-time: webhook processing
    │   ├── connector.js            #   Handles GOWA webhook format
    │   ├── rules.js                #   Spam (6 patterns), business JID, group detection
    │   └── manifest.json
    ├── calendar/                   # Batch: polls gws CLI every 2 hours
    │   ├── connector.js            #   Calls gws calendar, processes events
    │   ├── rules.js                #   Recurring collapse, auto-event filter, future filter
    │   └── manifest.json
    ├── gmail/                      # Batch: polls gws CLI every 2 hours
    │   ├── connector.js            #   Calls gws gmail, processes messages
    │   ├── rules.js                #   Newsletter filter (20+ domains, Gmail labels)
    │   └── manifest.json
    ├── slack/                      # Real-time: webhook processing
    │   ├── connector.js            #   Filters bots and agent accounts
    │   ├── rules.js                #   Known bot names Set
    │   └── manifest.json
    └── linear/                     # Batch: polls API every 4 hours
        ├── connector.js            #   GraphQL query for issues
        ├── rules.js                #   Issue state weighting
        └── manifest.json
```

---

## Validated Algorithms (from `intelligence_layer.py`)

### Scoring Engine — replaces flat +0.1

```python
scoreDelta = base_weight × channel_boost × recency_factor × reciprocity_bonus

base_weight: calendar_small=1.5, whatsapp_dm=1.2, email=1.0, calendar_large=0.8, linear=0.4, whatsapp_group=0.3
channel_boost: calendar/meeting=1.3, whatsapp=1.1, email/slack=1.0, linear=0.8
recency_factor: exp(-days_ago / 90)
reciprocity_bonus: 1.2 if bidirectional, 1.0 if one-way

Normalization: log(1 + raw) / log(1 + max) × 10
Cap per signal: 2.0
```

### Decay Engine — scores decrease over time

```
No decay for 7 days (grace period)
After 7 days: score × 0.98 per day
Floor: 0.5 (never fully forget)
Only decays scores > 1.0
```

Needs a daily cron job:
```cypher
MATCH (p:Person {userId: $userId})
WHERE p.last_interaction_at < (timestamp() - 7*24*60*60*1000)
  AND p.relationship_score > 1.0
SET p.relationship_score = CASE
  WHEN p.relationship_score * 0.98 < 0.5 THEN 0.5
  ELSE p.relationship_score * 0.98
END
```

### Canonical Name Resolver — 8/8 accuracy

Identifier-centric (email/phone are truth, names are ambiguous):
1. Group by shared email
2. Group by shared phone
3. Email-local-part-to-name matching ("ramongberrios" → "Ramon Berrios")
4. Cross-group abbreviation matching ("Ramon B" → "Ramon Berrios") with convergence loop
5. Single-first-name to full-name ("Suhas" → "Suhas Sumukh") only if name > 4 chars

Never merges different people: "Deep Patange" ≠ "Deepak M", "Imran Sable" ≠ "Imran Sir".

### First-Time Ingestion Split

Tested on 690 real contacts:
- **84% resolved by rules** (email domains, known teams, family names, low-interaction noise)
- **16% need AI** (111 contacts, 6 LLM batch calls, ~12 min)
- **After setup**: 0 LLM calls for ongoing ingestion

---

## Known Issues — Must Fix

### 1. API waitUntil Not Working in Production — CRITICAL

**Symptom**: Bulk ingest still takes 10-44s instead of returning immediately.
**Evidence**: 10 interactions = 9.7s, 50 = 43.6s, 100 = 80.9s.
**Root cause**: Unknown. The code uses `waitUntil` from `@vercel/functions` with try/catch fallback. Either the import isn't resolving, the catch is triggering (falling back to await), or Vercel hasn't fully deployed.
**Debug steps**:
1. Check Vercel dashboard for build success
2. Check Vercel function logs after a test ingest call
3. Test if `@vercel/functions` is in the deployed bundle (`package.json` dependency)
4. Try the Next.js App Router native `unstable_after` as an alternative to `waitUntil`

### 2. API Creates Orphan Nodes — MEDIUM

**Symptom**: `POST /ingest` with persons not in any interaction creates disconnected nodes.
**Evidence**: Sent `{persons: [{name: "ORPHAN"}], interactions: []}` → personsCreated: 1.
**Plugin-level fix**: Done (orbit_ingest tool filters persons not in interactions, 12/12 tests pass).
**API-level fix needed**: Add same filter server-side in `processIngest()`:
```typescript
const participantNames = new Set(
  interactions.flatMap(ix => ix.participants?.map(n => n.trim().toLowerCase()) ?? [])
);
persons = persons.filter(p => participantNames.has(p.name.trim().toLowerCase()));
```

### 3. Existing Duplicate Persons — MEDIUM

**Symptom**: Ramon has 4 nodes ("Ramon Berrios", "Ramon B", "ramongberrios", "Ramon").
**Fix**: One-time dedup migration in Neo4j. Group by fuzzy name, merge scores, re-point edges.
**Prevention**: The canonical name resolver prevents future duplicates.

### 4. Scores Never Decay — LOW

**Symptom**: Contacts from 6 months ago still have high scores.
**Fix**: Daily cron job (Vercel Cron or external) runs the decay Cypher above.

---

## Deployment Steps

### 1. Debug waitUntil on Vercel
The code is already pushed to GitHub and deployed. Check why it's not backgrounding.

### 2. Add server-side orphan filter
One code change in `src/app/api/v1/ingest/route.ts`, commit, push.

### 3. Deploy plugin to Wazowski
```bash
rsync -avz --exclude node_modules \
  ~/Documents/projects/personal/orbit/packages/orbit-plugin/ \
  claw:~/.openclaw/plugins/orbit-saas/

ssh claw 'cd ~/.openclaw/plugins/orbit-saas && npm install better-sqlite3'
```

Ensure `ORBIT_API_KEY=orb_live_<REVOKED-KEY-REDACTED>` is in the environment.

### 4. Verify
```bash
# Check plugin starts
ssh claw 'tail -50 ~/.openclaw/logs/commands.log | grep orbit'

# Check graph stats
curl -s "https://orbit-mu-roan.vercel.app/api/v1/graph" \
  -H "Authorization: Bearer orb_live_<REVOKED-KEY-REDACTED>"

# Test bulk ingest (should be <1s after waitUntil fix)
curl -s -X POST "https://orbit-mu-roan.vercel.app/api/v1/ingest" \
  -H "Authorization: Bearer orb_live_<REVOKED-KEY-REDACTED>" \
  -H "Content-Type: application/json" \
  -d '{"interactions":[{"participants":["Test"],"channel":"test","summary":"Verify"}]}'
```

---

## What's NOT Built Yet (Future)

1. **Intelligence redesign** — rules produce evidence objects, AI maps full relationship topology. See `BRAINSTORM-intelligence-redesign.md`.
2. **Decay cron job** — daily score decay, not yet implemented.
3. **Dedup migration** — one-time Neo4j cleanup for existing duplicate persons.
4. **wacli continuous sync** — wacli is installed on Wazowski but only ran once. Needs `wacli sync --follow` as a service for continuous contact name updates.
