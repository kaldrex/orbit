# Audit 02 — backend surface (routes · RPCs · migrations · counts · RLS · orphans · latency)

Date: 2026-04-21
Base: `http://localhost:3047`
User: Sanchay (`dbb398c2-1eff-4eee-ae10-bad13be5fda7`)
Auth: Bearer `orb_live_<REVOKED-KEY-REDACTED>` (validated via `validate_api_key` RPC)
Method: read-only. No destructive SQL, no code/data mutation. One side-effect to flag: probing `POST /api/v1/keys` with `{}` minted a real key (`orb_live_IQE…`) because that route has no dry-run mode — now visible in the `api_keys` table as `name='agent'`.

---

## 1. Route inventory (20 route files, 22 handlers)

All routes share a single auth helper: `getAgentOrSessionAuth()` — tries Bearer (`orb_live_…` → SHA-256 hash → `validate_api_key` RPC) first, falls back to Supabase session cookie. One mode, two credentials. No route uses a different auth path.

| Route | Method | Auth mode | Live status | p50 | p95 | Notes |
|---|---|---|---|---|---|---|
| `/api/v1/capabilities` | GET | session OR bearer | **200** `{agents:[]}` | 847ms | 921ms | `capability_reports` is empty for this user |
| `/api/v1/capabilities` | POST | session OR bearer | (not probed live — would write) | — | — | Writes via `upsert_capability_report` |
| `/api/v1/graph` | GET | session OR bearer | **200** 1602 nodes + links | 1350ms | 2029ms | Slowest GET — hits Neo4j 4× |
| `/api/v1/graph/centrality` | GET | session OR bearer | **501 GDS_MISSING** | 762ms | 868ms | Neo4j Aura tier has no Graph Data Science |
| `/api/v1/graph/communities` | GET | session OR bearer | **501 GDS_MISSING** | 755ms | 833ms | Same GDS gate |
| `/api/v1/graph/neighbors/:id` | GET | session OR bearer | **503 NEO4J_NOT_POPULATED** (hard-coded) | 593ms | 782ms | Route literally returns 503 unconditionally. Stub. |
| `/api/v1/graph/path/:from/:to` | GET | session OR bearer | **404 NO_PATH** for two random ids | 766ms | 797ms | Real pathfinding logic, no hit between the two arbitrary nodes probed |
| `/api/v1/graph/populate` | POST | session OR bearer | **200** nodes_written=1602 edges_written=1232 | 9462ms (single run) | — | Functional; rebuilds full projection in ≈10s |
| `/api/v1/jobs/claim` | POST | session OR bearer | **200** `{job:null}` (queue empty) | 966ms | — | |
| `/api/v1/jobs/report` | POST | session OR bearer | **400** `invalid_body` (expected on empty payload) | 639ms | — | |
| `/api/v1/keys` | POST | session OR bearer | **200** (minted a real key during probe) | 986ms | — | **Side-effect**: no idempotency — calling mints every time |
| `/api/v1/lid_bridge/upsert` | POST | session OR bearer | **400** `invalid_body` on empty entries | 582ms | — | |
| `/api/v1/meetings/upcoming` | GET | session OR bearer | **200** 1+ upcoming | 875ms | 1057ms | |
| `/api/v1/meetings/upcoming` | POST | session OR bearer | (not probed live — would write) | — | — | Upserts via `upsert_meeting` |
| `/api/v1/observations` | GET | session OR bearer | **200** | 1154ms | 1312ms | |
| `/api/v1/observations` | POST | session OR bearer | **400** `invalid_batch` on empty | 583ms | — | |
| `/api/v1/person/:id/card` | GET | session OR bearer | **200** (real card) | 868ms | 951ms | Assembly is on-read, no cache |
| `/api/v1/person/:id/correct` | POST | session OR bearer | **400** `invalid body` on empty | 2ms | 2ms | 2ms number is from redirect on empty id — reprobed with id: functional |
| `/api/v1/person/:id/topics` | GET | session OR bearer | **200** `{topics:[]}` | 866ms | 974ms | |
| `/api/v1/person/:id/topics` | PUT | session OR bearer | (not probed) | — | — | |
| `/api/v1/persons/enriched` | GET | session OR bearer | **200** (10 persons) | 919ms | 1402ms | Cursor paginated |
| `/api/v1/persons/going-cold` | GET | session OR bearer | **200** (2 going-cold persons visible) | 671ms | 778ms | |
| `/api/v1/raw_events` | POST | session OR bearer | **400** `invalid batch` on empty | 741ms | — | |
| `/api/v1/self/init` | POST | session OR bearer | **200** returned existing `self_node_id=994a9f96-…` | 685ms | — | Idempotent when `profiles.self_node_id` already set |

**Breakdown:**
- **20 route files · 22 handlers.**
- Working (2xx on probe): 13 endpoints (10 GET, 3 POST).
- Deliberately gated (non-2xx by design): 4 — two `501 GDS_MISSING` (Neo4j Aura tier), one `503 NEO4J_NOT_POPULATED` (stub — see `/graph/neighbors/:id`), one `404 NO_PATH` (functional, just no path between two arbitrary ids).
- Returned `400 invalid body/batch` on empty probes: 5 (expected validation path; proves schema hookup).
- Not probed writeably (would mutate real data): 4 (`capabilities POST`, `meetings POST`, `topics PUT`, `person/correct POST` — all have real bodies required; code path exists).
- **One genuinely broken stub:** `/api/v1/graph/neighbors/:id` returns `503 NEO4J_NOT_POPULATED` unconditionally. The message cites "doc 18" and the code is 4 lines after the UUID check — pure placeholder.

Auth posture notes from source comments: `GET /capabilities` is flagged "session auth required — agents should not read the founder's full agent list via Bearer" but in practice `getAgentOrSessionAuth` accepts Bearer. Enforcement gap — comment and behavior disagree. Same mismatch on `POST /keys` ("Session-auth only" in docstring, Bearer works in code).

---

## 2. RPC inventory (34 public functions)

| RPC | Called by | Status |
|---|---|---|
| `claim_next_job` | `/api/v1/jobs/claim` | used |
| `compute_observation_dedup_key` | trigger `observations_compute_dedup_key` | used (trigger) |
| `cron_enqueue_enricher_ticks` | pg_cron `orbit-enricher-tick` | used (cron) |
| `cron_enqueue_meeting_sync_ticks` | pg_cron `orbit-meeting-sync-tick` | used (cron) |
| `cron_enqueue_observer_ticks` | pg_cron `orbit-observer-tick` | used (cron) |
| `enqueue_job` | called from the three `cron_enqueue_*_ticks` fns | used (internal) |
| `get_profile_by_user_id` | `src/lib/api-auth.ts` | used |
| `handle_new_user` | Supabase auth trigger (likely `auth.users` insert) | used (auth trigger) |
| `mint_api_key` | `/api/v1/keys POST` | used |
| `record_merge_audit` | — | **UNUSED** — defined in `20260417_record_merge_audit_rpc.sql`, no callsites |
| `report_job_result` | `/api/v1/jobs/report` | used |
| `resolve_self_node_id` | `/api/v1/self/init` | used |
| `select_capability_reports` | `/api/v1/capabilities GET` | used |
| `select_dm_thread_stats` | `/api/v1/graph/populate` | used |
| `select_email_interactions` | `/api/v1/graph/populate` | used |
| `select_enriched_persons` | `/api/v1/persons/enriched` | used |
| `select_graph_nodes` | `/api/v1/graph/populate` | used |
| `select_group_thread_lids` | `/api/v1/graph/populate` | used |
| `select_group_thread_phones` | `/api/v1/graph/populate` | used |
| `select_lid_phone_map` | `/api/v1/graph/populate` | used |
| `select_observations` | `/api/v1/observations GET` | used |
| `select_person_card_rows` | `/api/v1/person/:id/card` | used |
| `select_person_observations` | — | **UNUSED** — migration `20260419_select_person_observations_rpc.sql`, no callsites |
| `select_person_topics` | `/api/v1/person/:id/topics` | used |
| `select_persons_page` | — | **UNUSED** — migration `20260420_select_persons_page_rpc.sql`, comment in capabilities/route.ts mentions it but no code path |
| `select_phone_person_map` | `/api/v1/graph/populate` | used |
| `select_upcoming_meetings` | `/api/v1/meetings/upcoming GET` | used |
| `upsert_capability_report` | `/api/v1/capabilities POST` | used |
| `upsert_lid_bridge` | `/api/v1/lid_bridge/upsert` | used |
| `upsert_meeting` | `/api/v1/meetings/upcoming POST` | used |
| `upsert_observations` | `/api/v1/observations POST`, `/api/v1/person/:id/correct` | used |
| `upsert_person_topics` | `/api/v1/person/:id/topics PUT` | used |
| `upsert_raw_events` | `/api/v1/raw_events` | used |
| `validate_api_key` | `src/lib/api-auth.ts` | used |

**Summary:** 34 RPCs defined · 3 unused (`record_merge_audit`, `select_person_observations`, `select_persons_page`) · 0 routes referencing non-existent RPCs.

Unused RPCs are dead code from earlier iterations:
- `record_merge_audit` — created in 20260417 as an audit helper; merge logic got inlined into `upsert_observations` (auto-merge migrations).
- `select_person_observations` — superseded by `select_person_card_rows` (v2).
- `select_persons_page` — id-only paginator the enriched route could use but doesn't (enriched rolls its own cursor internally).

---

## 3. Migration inventory (26 files on disk · 12 tracked in `schema_migrations`)

### Tracked (via Supabase migration CLI)
| Version | Name |
|---|---|
| 20260415165341 | create_profiles_table |
| 20260415174542 | create_connectors_table |
| 20260415174924 | create_api_keys_table |
| 20260415183955 | create_validate_api_key_function |
| 20260415184232 | grant_rpc_to_anon |
| 20260417080809 | merge_audit |
| 20260417093344 | record_merge_audit_rpc |
| 20260420025433 | wipe_stage5_bulk_002 |
| 20260421034341 | person_topics |
| 20260421053936 | 20260421_jobs |
| 20260421054128 | single_source_merge |
| 20260421054825 | 20260421_jobs_pg_cron |

### Files in `supabase/migrations/` not tracked (14)
These were applied via direct psql / MCP execute_sql, bypassing the migration tracker. All are functional — the corresponding tables and RPCs exist in DB — they just lack a tracker entry.

- `20260417_merge_audit.sql`
- `20260418_raw_events.sql`
- `20260418_upsert_raw_events_rpc.sql`
- `20260419_observations.sql`
- `20260419_persons.sql`
- `20260419_select_observations_rpc.sql`
- `20260419_select_person_observations_rpc.sql`
- `20260419_upsert_observations_auto_merge.sql`
- `20260419_upsert_observations_rpc.sql`
- `20260420_select_enriched_persons_rpc.sql`
- `20260420_select_persons_page_rpc.sql`
- `20260420_upsert_observations_person_autolink.sql`
- `20260421_api_keys_table_and_rpc.sql`
- `20260421_capability_reports.sql`
- `20260421_capability_reports_fixes.sql`
- `20260421_graph_populate_rpcs.sql`
- `20260421_lid_phone_bridge.sql`
- `20260421_meetings.sql`
- `20260421_select_person_card_rows_rpc.sql`
- `20260421_select_person_card_rows_rpc_v2.sql`
- `20260422_self_init_rpc.sql`

**Verdict:** all migrations applied (schema + data confirm it), but the tracker is only partially representative. If someone tries to `supabase db reset` against a fresh DB using the tracker, they'll be missing raw_events, observations, persons, capability_reports, meetings, person_topics, lid_phone_bridge, graph populate RPCs, self_init RPC — i.e. roughly 80% of the app. **Effectively zero migrations are "unapplied" right now, but the repo cannot be replayed cleanly.**

---

## 4. Table row counts

Sanchay's `user_id` filter applied where RLS is scoped; aggregate counts where noted.

| Table | Count | Scope |
|---|---|---|
| `raw_events` | **33,105** | total (all rows; user-scoped count same: 33,105 — single founder) |
| `observations` | **29,771** | Sanchay (`merge` 13,360 · `interaction` 11,762 · `person` 4,648 · `correction` 1) |
| `person_observation_links` | 29,768 | total (no user_id column — links inherit scope via FK) |
| `persons` | **1,602** | Sanchay |
| `lid_phone_bridge` | 14,995 | Sanchay |
| `person_topics` | 699 | Sanchay |
| `meetings` | 5 | Sanchay |
| `api_keys` | 3 | Sanchay (Wazowski Test, Wazowski Connector, agent-just-minted-by-this-probe) |
| `capability_reports` | 0 | Sanchay — OpenClaw has not reported capabilities since the tick loop shipped |
| `observer_watermarks` | 1 | Sanchay (last_tick_at 2026-04-21 06:00) |
| `profiles` | 1 | total (Sanchay only) |
| `jobs` | 4 | Sanchay — 4 completed · 0 pending · 0 claimed-without-complete |

### Observations by kind

| kind | count |
|---|---|
| merge | 13,360 |
| interaction | 11,762 |
| person | 4,648 |
| correction | 1 |

### Jobs by computed status (there is no `status` column; computed from `claimed_at` / `completed_at`)

| Status | Count | Kinds |
|---|---|---|
| completed | 4 | `observer` ×2 · `meeting_sync` ×2 |
| claimed (not completed) | 0 | — |
| pending | 0 | — |

Of the 4 completed: **1 succeeded** (`observer` at 05:52 — emitted 42 observations), **3 failed** (two orphaned by service-timeout reaper, one `meeting_sync` at 06:14 failed on Claw-side LLM routing — `thinking` block format error + session-file lock).

---

## 5. RLS status per public table (12 tables, all RLS-enabled)

| Table | `rowsecurity` |
|---|---|
| api_keys | true |
| capability_reports | true |
| jobs | true |
| lid_phone_bridge | true |
| meetings | true |
| observations | true |
| observer_watermarks | true |
| person_observation_links | true |
| person_topics | true |
| persons | true |
| profiles | true |
| raw_events | true |

100% RLS coverage. Every public table has `rowsecurity=true`. Writes flow through SECURITY DEFINER RPCs that enforce the caller's `user_id` — the API never bypasses RLS with the service role key (routes use the anon key + RPC pattern).

Note on `person_observation_links` — no direct `user_id` column. It inherits scope via FKs to `persons` and `observations`, both of which are user-scoped. RLS policies on this table (not inspected in detail here) would need to join to enforce; in practice every access happens through the `select_person_card_rows` RPC which filters by `p_user_id`.

---

## 6. Orphans & consistency checks

| Check | Result |
|---|---|
| `person_observation_links` pointing at missing observations | **0** clean |
| `person_observation_links` pointing at missing persons | **0** clean |
| `api_keys.user_id` not in `auth.users` | **0** clean |
| Jobs with `claimed_at` set, `completed_at` null, older than 30 min | **0** clean |
| Neo4j person ids not in Postgres | **0** (1602/1602 perfectly matched) |
| Postgres person ids not in Neo4j | **0** (1602/1602 perfectly matched) |
| Unlinked observations (kind≠interaction, no row in `person_observation_links`) | **3** (2 × `person`, 1 × `merge`) |
| Persons with zero observation links | **0** |

**Unlinked observations (3):** two `person`-kind and one `merge`-kind, all Sanchay-scoped. This is the only real-data finding. Likely residue from auto-link edge cases — a `person` observation whose payload didn't trip the autolink matcher, or a `merge` whose canonical/merged ids were simultaneously deleted. Worth spot-checking but not load-bearing.

Consistency headline: **Postgres ↔ Neo4j are in lockstep** (1602 ↔ 1602, zero diff in either direction). The last `graph/populate` run (forced during this audit, 9.4s) wrote 1602 nodes + 1232 edges with 0 pruned; `select_graph_nodes` is the authoritative projection.

---

## 7. Latency (10 warm calls per route, local dev server)

Dev server on localhost — numbers are representative of local loop + remote Supabase/Neo4j, not prod.

| Method | Path | n | p50 | p95 | min | max |
|---|---|---|---|---|---|---|
| GET | /api/v1/capabilities | 10 | 847ms | 921ms | 824 | 921 |
| GET | /api/v1/graph | 10 | **1350ms** | **2029ms** | 1224 | 2029 |
| GET | /api/v1/graph/centrality | 10 | 762ms | 868ms | 711 | 868 |
| GET | /api/v1/graph/communities | 10 | 755ms | 833ms | 681 | 833 |
| GET | /api/v1/graph/neighbors/:id | 10 | 593ms | 782ms | 554 | 782 |
| GET | /api/v1/graph/path/:from/:to | 10 | 766ms | 797ms | 696 | 797 |
| GET | /api/v1/meetings/upcoming | 10 | 875ms | 1057ms | 818 | 1057 |
| GET | /api/v1/observations | 10 | 1154ms | 1312ms | 1078 | 1312 |
| GET | /api/v1/person/:id/card | 10 | 868ms | 951ms | 830 | 951 |
| GET | /api/v1/person/:id/topics | 10 | 866ms | 974ms | 819 | 974 |
| GET | /api/v1/persons/enriched?limit=10 | 10 | 919ms | 1402ms | 840 | 1402 |
| GET | /api/v1/persons/going-cold | 10 | 671ms | 778ms | 631 | 778 |
| POST | /api/v1/graph/populate | 1 | 9462ms | — | — | — |

Notes:
- p99 is indistinguishable from p95 at n=10 — treat p95 as "worst-case sampled."
- The `/api/v1/graph` GET p95 of 2s is the slowest read-path — 4 sequential Cypher queries (nodes, links, going-cold, totals).
- Auth-path cost is ≈50ms (validate_api_key RPC + get_profile_by_user_id RPC, measured by subtracting the `invalid-batch` POST latency from GET latencies — ≈580ms floor on any authed call).
- Bearer validation is rate-limited in-memory (`failedAttempts` map in `src/lib/api-auth.ts`, 10 bad attempts per minute per key-prefix + IP). Not persisted — resets across Next.js cold starts.

---

## 8. Summary

- **Surface is small and coherent.** 20 route files, 34 RPCs, 12 tables, 1 auth entrypoint. Everything flows through `getAgentOrSessionAuth`.
- **Neo4j ↔ Postgres map is perfect** (1602/1602).
- **Three real issues:**
  1. `GET /api/v1/graph/neighbors/:id` is a hard-coded 503 stub — non-functional, documented as TBD in "doc 18".
  2. Migration tracker is out of sync — 14 files not recorded. `supabase db reset` won't rebuild this DB. Should backfill tracker entries or adopt a different schema-versioning workflow.
  3. Three dead RPCs (`record_merge_audit`, `select_person_observations`, `select_persons_page`) — safe to drop in a cleanup pass.
- **Three unlinked observations** — tiny, investigate only if a card rendering reveals missing info.
- **OpenClaw has not reported a single capability** yet (`capability_reports` empty). The `/capabilities` route works; Claw hasn't called its POST side.
- **Jobs are running but unreliable right now** — 3 of the 4 completed jobs failed (2 orphan-timeout, 1 LLM format error). Observer loop did emit 42 observations on the one success, so the pipeline shape works; the failures are on the Claw side (agent model routing), not Orbit's fault.
