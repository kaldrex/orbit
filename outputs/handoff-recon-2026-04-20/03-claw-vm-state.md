# Claw VM recon — 2026-04-20

**Status: RECON FAILED — VM unreachable. Live probes could not be run.** This report substitutes last-known-good data from the 2026-04-19 EDA (`agent-docs/10-eda-findings-2026-04-19.md`) and local Stage-5/5c/6 artifacts, with an unambiguous freshness flag on every number.

---

## Reachability (attempted probes)

| Target | Result |
|---|---|
| `ssh claw` (public GCP IP `34.14.170.5:22`) | `connect: Operation timed out` after 15s |
| `ssh claw-ts` (Tailscale `100.109.184.64`) | `connect: Operation timed out` after 10s |
| `ping 34.14.170.5` | 100% packet loss |
| `ping 100.109.184.64` | 100% packet loss |
| `tailscale status` → `openclaw-sanchay` | **`offline, last seen 2h ago`** at probe time (2026-04-20 ~18:55 local) |
| `gcloud compute instances list` | Auth token expired, cannot confirm GCP-side instance state in non-interactive run |

Note on task brief: the brief quoted the Tailscale IP as `100.97.152.84`, but that address is actually the user's Mac (`192-1`, macOS) per `tailscale status`. The real Tailscale IP for `openclaw-sanchay` is `100.109.184.64` and it is **offline**. This is not a routing issue — the VM/Tailscale daemon is down or the VM is stopped.

**None of probes 1–9 could be executed.** Everything below is historical, pulled from committed artifacts on the Mac.

---

## VM health

Unknown (last live check was 2026-04-19 EDA, ~30h ago; no persistent disk/mem snapshot captured into the repo at that time). Tailscale last-seen 2h indicates the VM was live earlier today but is now either stopped, rebooting, or partitioned. Not a crash — no alarm logs elsewhere in the repo.

---

## OpenClaw install state (last-known, 2026-04-19 EDA)

Plugins and skills believed present on claw per `agent-docs/11-v0-pipeline-handoff-2026-04-19.md` and the `orbit-claw-skills/`, `orbit-cli-plugin/`, `orbit-rules-plugin/` trees in this worktree:

- **Plugins.** `orbit-rules-plugin` (10 modules: safety, name, group-junk, bridge, forwarded, lid, phone, email, fuzzy, domain + `data/domains.json`), `orbit-cli-plugin` (4 verbs: `orbit_observation_emit`, `orbit_observation_bulk`, `orbit_person_get`, `orbit_persons_list_enriched`).
- **SKILLs.** `orbit-observer` and `orbit-resolver` under `orbit-claw-skills/`. (Enricher was run off the Mac via `scripts/run-stage-6-v4.mjs` against the HTTP API, not as a claw SKILL — memory `project_agent_is_the_contract.md` has this right, but Stage 6 specifically ran from the founder's machine, per `outputs/stage-6-v4-2026-04-20/run.log`.)

Directories expected on disk (`~/.openclaw/plugins/`, `~/.openclaw/workspace/skills/`) — **unverified today**.

---

## Data-source row counts (last-known, 2026-04-19 ~13:37 UTC per EDA)

Source: `agent-docs/10-eda-findings-2026-04-19.md` + `outputs/stage-5c-reingest-2026-04-20/reingest-summary.json`.

| Store | Path | Rows (as of 2026-04-19) |
|---|---|---|
| `wacli.db` — `messages` | `~/.wacli/wacli.db` | **~33,105** (matches `raw_events` after bulk copy, zero-skip UTF-8 sanitizer). `max(timestamp)` at last live read: 2026-04-17 13:37 UTC → **already 2 days stale at the time of the EDA**. |
| `wacli.db` — `contacts` | same | **11,822** rows `(jid, phone, push_name, full_name)` |
| `wacli.db` — `chats` | same | Umayr DM thread alone was 3,371 msgs over 2026-02-06 → 2026-04-12; total chat count not captured in the EDA but the DM index exists. |
| `wacli.db` — `groups`, `group_participants` | same | Present per EDA narrative; exact row counts not captured. |
| `session.db` — **`whatsmeow_lid_map`** (LID bridge) | `~/.wacli/session.db` | **14,995 LID↔phone pairs**. This table is the hard dependency for resolving group-participant `@lid` rows. |
| Gmail + Contacts NDJSON exports | `~/.orbit-export/` | ~25 MB total: `gmail-*.ndjson`, `google-contacts-*.ndjson`, Calendar exports. Present as of 2026-04-19. |

**Freshness flag.** The wacli DM pipeline was 2 days stale *at the time of the EDA*, meaning today it is at minimum ~4 days stale. This pre-dates the observed Tailscale drop and is a separate issue: `wacli` itself needs to have its WhatsApp session still paired.

---

## Recent run activity

Last observer/resolver invocations are not directly visible in this recon (would require `ls -lat ~/.openclaw/workspace/*/outputs/` on claw). The last end-to-end pipeline activity reflected in the worktree, all executed from the founder's Mac against the HTTP API, not on claw:

| Run | Date | Outcome |
|---|---|---|
| Stage 5 bulk ingest | 2026-04-19 22:11 | 33,105 raw_events written |
| Stage 5b merges | 2026-04-19 22:29 | bridge resolver, merges written |
| Stage 5c re-ingest (v3 manifest) | 2026-04-20 08:28 | 1,603 person obs + 1,603 merge obs + 3,206 links, 0 conflicts |
| Stage 6 enrichment (v3) | 2026-04-20 14:27 | 1,568 persons enriched, $4.03, 0/50 vague |
| **Stage 6 enrichment (v4, LID fix)** | **2026-04-20 16:44 → 17:22** | **1,470 persons, $4.52, verdict `STAGE6_V4_PASS`, 415 persons moved out of `other`** |
| Docs refresh | 2026-04-20 18:01 | CLAUDE.md + 03-current-state + README rewrites |

**Nothing is currently running.** No enricher process was invoked today by Claude, and claw itself is unreachable so any cron there cannot be verified. Safe working assumption: **no enricher running, no Anthropic spend in progress.**

---

## Env state (secrets redacted)

Cannot read `~/.openclaw/.env` live. From plugin code and docs, the variables expected to be set on claw are:

- `ANTHROPIC_API_KEY` — for observer/resolver SKILL invocations
- `ORBIT_API_URL` — points to the Mac's Tailscale address + port `3047` (memory `project_dev_tailnet_routing.md`)
- `ORBIT_API_KEY` — bearer token for the HTTP API
- `WACLI_DB`, `WACLI_SESSION_DB` — optional overrides (default to `~/.wacli/wacli.db`, `~/.wacli/session.db`)
- Standard OpenClaw runtime vars (workspace path, plugin dir)

No rotation needed; nothing to redact from this report because nothing was read.

---

## Stage-7 readiness (watermark infrastructure)

**Not built. Not a cron. Not a file. Not a design handoff.**

Evidence:

- `agent-docs/15-future-props.md:86` explicitly calls Stage 7 "continuous loop — not yet built"
- `agent-docs/16-how-it-works-end-to-end.md:191` states: "**Currently:** not wired. Orbit's DB is a snapshot of 2026-04-20. This is what Stage 7 will build."
- `agent-docs/16-how-it-works-end-to-end.md:299,303` rate "continuous refresh" and "resilience primitives (progress file, retries, ETA)" as **not built**.
- `agent-docs/17-resilient-worker-design.md` exists only as design-only; it is the **precondition** for Stage 7, not an implementation. It proposes a progress file, DLQ, circuit breaker, ETA — none of which exist on disk yet.
- `grep` across the whole tree finds **zero `watermark*`, `progress*`, or `*cursor*` files** in `scripts/`, `orbit-claw-skills/`, or `orbit-*-plugin/`.

Stage 7 currently has to build: (a) a watermark file schema (per-source: wacli messages `rowid`, Gmail `historyId`, Calendar sync-token), (b) the resilient-worker library per `17-resilient-worker-design.md`, (c) the OpenClaw `heartbeat` cron entry that invokes the observer-dispatcher.

---

## Recommended next steps (not executed per brief)

1. **Get claw back online first.** Check Tailscale daemon on the VM or restart via GCP console. Without SSH access, no enrichment-loop work is possible, and `wacli` itself may have lost its WhatsApp pairing (last DB write was 2026-04-17).
2. **Confirm `wacli auth` once claw is up** — the `~/.wacli/wacli.db` `max(timestamp)` should be current. If it still says 2026-04-17, re-auth is needed.
3. **Re-run this recon live** once SSH is restored to replace the last-known-good numbers here with true live counts.
4. **Then** scope Stage 7 per `17-resilient-worker-design.md`.

---

## Report limitations

This file reflects only the state that could be read from the Mac side of the system today. Every row count, every plugin presence claim, and every env variable is **last-known-good from 2026-04-19**, not a 2026-04-20 live probe. Do not cite these numbers without the date qualifier.
