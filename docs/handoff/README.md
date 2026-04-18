# Orbit v2 Handoff — Next-Session Entry Point

## 👉 Start here (newest first)

**The canonical resume point is [`09-2026-04-18-track2-done.md`](./09-2026-04-18-track2-done.md).** Read that first — it tells you where we are, what's live, and exactly what to do next.

Everything below is older context, kept for reference. The architecture landed in the 2026-04-18 specs under [`docs/superpowers/specs/`](../superpowers/specs/) supersedes any "next step" advice in `03-problems.md` / `04-next-steps.md`.

## Reading order (if starting from zero)

1. **[`09-2026-04-18-track2-done.md`](./09-2026-04-18-track2-done.md)** — Current state of the world (Track 1 + 2 done, 33 k rows in ledger, Track 3 is next).
2. **[`../superpowers/specs/2026-04-18-orbit-v0-design.md`](../superpowers/specs/2026-04-18-orbit-v0-design.md)** — Canonical architecture. Three durable layers, observation feedback loop, V0 scope.
3. **[`../superpowers/specs/2026-04-18-testing-and-verification.md`](../superpowers/specs/2026-04-18-testing-and-verification.md)** — Testing contract. "No claim without evidence."
4. **[`../superpowers/plans/2026-04-18-orbit-v0-master-roadmap.md`](../superpowers/plans/2026-04-18-orbit-v0-master-roadmap.md)** — 6-track execution plan with current checkboxes.
5. **[`../../outputs/verification-log.md`](../../outputs/verification-log.md)** — Every claim about the system backed by an artifact. Read when something looks off and you need to know what's actually true.

## Older context (pre-2026-04-18, now superseded)

- `01-system-overview.md` — how the system worked before the inverted-storage design
- `02-live-state.md` — older credentials/deploy snapshot
- `03-problems.md` — pre-spec backlog; most items absorbed into the 6-track plan
- `04-next-steps.md` — pre-spec next steps; use the master roadmap instead
- `05-neutral-handover.md`, `06-openclaw-orbit-universal-system.md`, `07-openclaw-runtime-reference.md` — architecture context, still useful for background
- `08-senior-engineer-dump-2026-04-17.md` — one day before the spec was written; good "why" context for the inversion

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
