# Research synthesis — 2026-04-20

Source docs: `outputs/research-2026-04-20/{competitive-landscape,dench-deep-dive,oss-algorithms}.md`.
Scope: turn three research outputs into operational knowledge for V0 positioning, build priorities, and competitive watchlist.

---

## 1. Competitive landscape (crisp)

**The field (≈15 credible personal CRMs).** Top: **Mesh** (ex-Clay.earth, $10/mo, rebranded after "personal CRM" framing failed), **Folk** ($24–48/seat, only native WhatsApp but via Chrome ext), **Dex** ($12–20/mo, mobile-first + real WhatsApp integration, ~30k users), **Monica** (free self-host, dated UI, no LinkedIn/Gmail), **Mogul** (E2E-encrypted niche, no LLM enrichment possible), **Nat.app** (thesis-correct, dormant execution), **Attio** ($29–119/seat, AI Attributes worth studying), **Affinity** ($85–100/seat, VC ceiling). Second tier: Covve, UpHabit, Claryti, Dossy, Relatable.

**Pricing white space.** $30 (Superhuman) → $85 (Affinity) is empty. Orbit fits: free self-host / $20–30 managed / $75–100 founder concierge.

**What nobody does.** (a) Long-tail discovery — every competitor optimizes top-30; (b) deep WhatsApp ingest — Folk/Dex are thin; (c) real privacy (only Monica); (d) agent feedback loop (only Orbit + DenchClaw architecturally can).

**Moves since April.** Clay → Mesh rebrand (signal the "personal CRM" category label is broken — stop using it). Humane/Rewind/Pi/Rabbit all dead or absorbed — ambient-memory-hardware category collapsed. Dex 2026 AI roadmap encroaches on Orbit turf (pre-meeting briefings).

**Orbit's wedge (one sentence):** WhatsApp-first cross-channel memory, agent-on-your-machine, surfaces the 400 people you forgot — a lane no incumbent occupies.

---

## 2. DenchClaw teardown

**Product.** Dench (YC S24, `dench.com`). DenchClaw = their local-first AI CRM, `npx denchclaw@latest → localhost:3100`, launched Feb/Mar 2026. 1.5k GH stars in ~10 weeks, 147 HN / 192 PH. Pivoted from "AI Intake for Law Firms"; legal intake still lives on site — two-horse ICP.

**Shared substrate (critical).** **OpenClaw is not theirs.** It's an independent MIT project (Peter Steinberger, ~360k stars, Nov 2025). Orbit's OpenClaw = DenchClaw's OpenClaw = same upstream. We co-reside on their framework layer, not compete with it. Both run on user's Mac, both call Claude (they confirmed Opus 4.6), both offer local-model fallback via Ollama.

**Different by design.**
- **Atom:** they = EAV row + pipeline stage (`v_people` PIVOT view on DuckDB); we = cross-channel person card assembled from observation ledger.
- **Surface:** they = kanban pipeline + SQL-by-LLM; we = discovery ("who did I forget").
- **Write-back:** they = agent sends LinkedIn/email as you (this is their killer demo AND their biggest HN backlash — "prompt injection as a service", Chrome-profile-copy); we = observations-only, by design.
- **Identity resolution:** they don't have one. Import Gmail+LinkedIn+HubSpot → 3 rows. Ours is a structural advantage.

**Steal:** (1) one-line installer (`npx orbit@latest`); (2) filesystem-projected `.object.yaml` schemas; (3) skill-file-per-integration architecture (matches our orbit-cli-plugin direction); (4) local-model fallback for EU/privacy narrative; (5) natural-language SQL over the person store.

**Avoid:** (1) copying full Chrome profile into agent; (2) EAV as core storage — painful to query for discovery; (3) kanban as default UI (forces funnel metaphor); (4) SEO content firehose with same-date timestamps (reputation cost); (5) two-horse ICP.

**Worry level:** low-to-moderate. 6-month risk window — if they ship deterministic identity resolution + a "who should I talk to" surface, they crowd us out.

---

## 3. OSS algorithms

### Splink (probabilistic entity resolution, Fellegi-Sunter + EM, DuckDB/Postgres backend, MIT)
- **Does:** calibrated match weights per feature (log2 match-rate / non-match-rate), 1M rec/min on laptop, Supabase PG is a supported backend.
- **Adopt:** **now (as a model, not a library).** Python sidecar is overkill — port the Splink *model* to SQL. Enable `pg_trgm` + `fuzzystrmatch` on Supabase, build `person_name_candidates` view with trigram similarity + Levenshtein + Double Metaphone, combine via Fellegi-Sunter weights. 1–2 days, zero Python. Replaces today's weakest link (Layer 2 token fuzzy-name bridge).

### Neo4j GDS — Louvain / Leiden / betweenness (Cypher procedures, GPL community)
- **Louvain / Leiden:** community partition of 6,809 humans → ~30–80 natural clusters ("Mumbai-tech", "Cursor India", "IIT batch"). Leiden strictly dominates Louvain (Traag 2019) — use Leiden.
- **Betweenness centrality:** bridge nodes = "introduce X to Y" candidates. O(VE) trivial at 6k.
- **PageRank / embeddings:** who's the hub; "find people similar to Ramon" without tags.
- **Adopt:** **now for Leiden (half-day win, single highest-signal viz upgrade).** Neo4j Aura is already in-stack but empty — need to hydrate + enable GDS tier. Betweenness + embeddings = later. Node-side mirror via `graphology-communities-louvain` (~4h) is a cheap fallback for preview viz.

### Levin/Walter/Murnighan — Dormant Ties (Org Science 22(4), 2011)
- **Does:** academic backbone for Orbit's entire thesis. Reconnected dormant ties outperform current ties on trust, novelty, efficiency. Typical person has ≥10 useful dormant ties. Not a library — a formula + finding.
- **Adopt:** **now as a product-design frame + a ranking rule.** Drops out for free once tie-strength scorer exists: `peak_30d_msg_count > 20 AND days_since_last_contact > 90`, rank by peak × recency_decay_inverse. Endpoint `GET /api/v1/persons/dormant?days=90`. Pair with Gilbert-Karahalios CHI 2009 feature dict (intimacy 32.8% + intensity 19.7% + duration 16.5%) for the scorer itself — ~200 LOC TS, recency decay with τ≈45 days, calibrate against Sanchay's own top-20 ranking (Dunbar 5/15/50/150 sanity check).

**Skip / later.** Automerge/Yjs CRDTs (multi-founder V2). DeepMatcher (stale). Zingg (AGPL risk). cuGraph (needs CUDA). LLM-first matching (cost fine at $0.15–1.50/full reconcile, but deterministic tail still has gains — Layer 3 is for ambiguity, not throughput).

---

## 4. Five things Sanchay might not have noticed

1. **"Personal CRM" as a category name is poisoned.** Clay had to rebrand to Mesh because the label didn't stick. Our current positioning docs still use "personal CRM" in places — say *relationship memory* or *network memory*. Contradicts any marketing copy that leans on the existing category.

2. **We're co-resident on DenchClaw's framework, not competing with it.** OpenClaw is Peter Steinberger's, not Dench's. Orbit could literally ship as an **OpenClaw skill pack that DenchClaw users install** when their EAV CRM can't answer "who did I forget." This inverts the competitive frame from rival → complement.

3. **Layer 2 (token fuzzy-name bridge) is the highest-leverage deterministic win left** — and the roadmap treats it as solved. Splink-as-SQL-model with pg_trgm + Double Metaphone closes real misses in 1–2 days without a Python sidecar or Layer 3 LLM escalation. The plan's current "LLM-next" instinct skips this win.

4. **DenchClaw's biggest feature gap = shipping surface.** They have a one-line installer, landing page, skills store, Show HN, PH, GitHub stars. We have none of those. Closing this gap is more valuable than any feature — a stranger cannot try Orbit today. This is a roadmap priority inversion.

5. **Dex's 2026 AI roadmap encroaches on Orbit territory** (pre-meeting briefings, auto-groups, WhatsApp integration). They have 30k users and mobile — the two things Orbit structurally cannot match short-term. Read their changelog monthly. The window to own "WhatsApp-first discovery" is narrower than the DenchClaw gap suggests.

---

## 5. Source links (anchors)

- `outputs/research-2026-04-20/competitive-landscape.md` — full competitor dossiers, pricing map, gap analysis, 50+ sources
- `outputs/research-2026-04-20/dench-deep-dive.md` — HN/PH traction, architecture confirmation, OpenClaw ownership finding
- `outputs/research-2026-04-20/oss-algorithms.md` — Splink/GDS/Gilbert/Levin/Dunbar with citations and concrete integration paths

Key external anchors: Traag 2019 (Leiden); Gilbert-Karahalios CHI 2009 (tie strength features); Levin-Walter-Murnighan Org Science 22(4) 2011 (dormant ties); Splink docs (Fellegi-Sunter in SQL); openclaw/openclaw GH (framework ownership).
