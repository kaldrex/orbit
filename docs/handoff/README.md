# Orbit v2 Handoff — Next-Session Entry Point

## Start here

Orbit is live end-to-end. Plugin installed on Wazowski, ingesting WhatsApp/Calendar/Gmail/Linear, graph at 1,003 persons and 9,153 INTERACTED edges. Web dashboard shows real data.

**BUT** — 93% of contacts have score < 2, 90% are category "other", 10 confirmed duplicate clusters, and the whole categorization/identity-resolution layer is effectively useless. This handoff folder tells the next session what to fix.

## Read in order

1. **`01-system-overview.md`** — How the whole thing works today: plugin → API → Neo4j → dashboard. Where each piece lives, what it does, who pays.
2. **`02-live-state.md`** — Current numbers, credentials, deployment locations. Facts you need to verify anything.
3. **`03-problems.md`** — Every issue the 3 audit subagents found. Grouped by severity. This is the backlog.
4. **`04-next-steps.md`** — Priority-ordered fix plan. Start at the top.

## The one problem to fix first

**Canonical identity resolution.** Ramon appears 3 times, Eric 3 times, Suhas 2 times, Ashutosh 2 times. Without merging, every query returns garbage. The data science team built a rule-based resolver (`CanonicalNameResolver` in `orbit-experiment/intelligence_layer.py`) but it's never been ported to TypeScript or run against production data. An LLM-powered pass is the right approach — we designed it last session. Details in `04-next-steps.md`.

## Quick verify commands

```bash
# Check current graph state
cd ~/Documents/projects/personal/orbit && node -e "
const neo4j = require('neo4j-driver');
const d = neo4j.driver('neo4j+s://3397eac8.databases.neo4j.io', neo4j.auth.basic('3397eac8', 'h_RPg5ECyd2d5nKikS1NQIRS5VkzXQ2D-zq3YRN_xTM'));
(async () => {
  const s = d.session({ database: '3397eac8' });
  const p = await s.run('MATCH (p:Person) RETURN count(p) as c');
  console.log('Persons:', p.records[0].get('c').toNumber());
  await s.close(); await d.close();
})();
"

# Check plugin health on Wazowski
ssh claw "journalctl --user -u openclaw-gateway --since '5 minutes ago' --no-pager 2>&1 | grep orbit | tail -10"

# Login to dashboard
open https://orbit-mu-roan.vercel.app/login
# sanchaythalnerkar@gmail.com / Sanchay@123
```
