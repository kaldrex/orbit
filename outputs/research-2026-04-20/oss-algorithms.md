# OSS algorithms and libraries relevant to Orbit

**Author:** research pass, 2026-04-20
**Scope:** entity resolution, graph algorithms, relationship scoring, local-first sync, LLM identity matching, messaging tooling, contact dedup
**Grounding:** Orbit today = Node/TS + Supabase Postgres + Neo4j Aura, 6,809 humans from ~33k WA + 2k Gmail + 342 Google Contacts, deterministic-first resolution (phones via `libphonenumber-js`, email normalization, WA LID→phone via `whatsmeow_lid_map`, token fuzzy name bridge), 0 wrong-merges in a 20-sample audit.

---

## 1. Executive summary

- **Entity resolution ecosystem is dominated by Python** (Splink, dedupe, Zingg, RLTK, py_entitymatching). Orbit is Node/TS — pulling these in means either a Python sidecar or re-implementing their ideas. **Splink is the most compelling** because it runs on DuckDB (embeddable, no JVM) and implements a proper Fellegi-Sunter probabilistic model with EM parameter estimation. Everything else is a step down.
- **For graph algorithms, stay in-stack.** Neo4j GDS already runs alongside Orbit and ships Louvain, Leiden, PageRank, betweenness, and node embeddings as Cypher procedures. If we want a JS-side mirror for preview/viz, `graphology` + its Louvain/Leiden/metrics subpackages is the clean pick. Drop any idea of adding `networkx`/`igraph` — wrong ecosystem.
- **Relationship scoring has a strong academic base but almost no OSS implementations.** Gilbert & Karahalios (CHI 2009) and Levin et al. (Org Science 2011, dormant ties) give us the feature dictionary and the reconnection thesis that maps directly onto "going cold" / "who did I forget." We'd implement our own scorer — this is a ~200 LOC job, not a library adoption.
- **Local-first / CRDT is not V0 work.** Automerge 3.0 (Rust + WASM, 10x memory cut) and Yjs are both mature; for the multi-founder future, Yjs has the wider adoption but Automerge's JSON data model fits Orbit's packet shape better. Park this. Not an architecture pressure today.
- **Biggest concrete opportunity is Layer 2 upgrade: replace the token fuzzy-name bridge with pg_trgm + phonetic encoding + embedding blocking, not LLM-first.** Deterministic wins are still on the table before we spend tokens. The LLM layer is for ambiguity, not throughput.

---

## 2. Entity resolution

### 2.1 Library comparison

| Library | Lang | Last active | License | Core model | Fit for Orbit |
|---|---|---|---|---|---|
| [Splink](https://github.com/moj-analytical-services/splink) | Python (DuckDB / Spark / Athena / Postgres) | active, 2025-2026 | MIT | Fellegi-Sunter probabilistic + EM | **High** — DuckDB backend embeddable, 1M records/min on a laptop. Supabase PG is a supported backend. |
| [dedupe](https://github.com/dedupeio/dedupe) | Python | active (commits through Sep 2025) | MIT | Active-learning logistic regression + blocking | Medium — requires interactive training on labeled pairs. 4.4k stars, mature. |
| [Zingg](https://github.com/zinggAI/zingg) | Java/Spark | active, updated 2026-03 | AGPL | ML with active learning | Low — Spark dependency is heavy. AGPL risk for any hosted service. |
| [RLTK](https://github.com/usc-isi-i2/rltk) | Python | active (USC/ISI, DARPA-funded) | MIT | Full pipeline, blocking + sklearn classifiers | Low — research-oriented, not productized. |
| [recordlinkage](https://github.com/J535D165/recordlinkage) | Python | active (issues through Feb 2025) | BSD-3 | Modular — indexing, comparison, classification | Low — academic toolkit, no live demo of scale. |
| [py_entitymatching (Magellan)](https://github.com/anhaidgroup/py_entitymatching) | Python | active (v0.4.2) | BSD | End-to-end supervised EM (UW-Madison) | Low — primarily educational. |
| [DeepMatcher](https://github.com/anhaidgroup/deepmatcher) | Python / PyTorch | stale | BSD | Deep learning for EM | Skip — not keeping pace with transformer era. |

### 2.2 Blocking & indexing algorithms

Blocking reduces the O(N²) problem by only comparing "plausibly same" records. Four families:

- **Deterministic blocking** — group by normalized key (phone prefix, email domain, name soundex). Orbit's Layer 1 is this.
- **Sorted Neighborhood** — sort on a composite key + slide a window. Tolerates off-by-one misalignment. Implemented in recordlinkage.
- **LSH** (MinHash/SimHash) — scales to 100M+ but produces large candidate sets per Papadakis et al.
- **Embedding + ANN (FAISS/HNSW)** — newer. [pyJedAI](https://github.com/AI-team-UoA/pyJedAI) and [BlockingPy](https://arxiv.org/html/2504.04266) wrap this. Overkill at 6k; right move at founders × ~1k each.

**Key paper:** Papadakis et al., *Benchmarking Filtering Techniques for Entity Resolution* (arxiv [2202.12521](https://arxiv.org/abs/2202.12521)) — cardinality-based NN methods beat LSH on recall/precision at our scale.

### 2.3 String similarity primitives

- [jellyfish](https://github.com/jamesturk/jellyfish) (Py, Go port) — Jaro/Jaro-Winkler, Levenshtein, Soundex, Metaphone, NYSIIS.
- [talisman](https://github.com/Yomguithereal/talisman) (Node, by graphology's author) — covers the same + Double Metaphone.
- **Postgres-native:** `pg_trgm` (trigram, GIN-indexed) + `fuzzystrmatch` (soundex/metaphone/Levenshtein). Both ship with Supabase — zero dependency cost.

---

## 3. Graph algorithms

### 3.1 Library choice

| Library | Lang | Active? | Strength | Weakness |
|---|---|---|---|---|
| [Neo4j GDS](https://neo4j.com/docs/graph-data-science/current/) | Cypher (server-side) | yes, shipping with Neo4j | In-DB, no data export, all majors algos | License: GPL for community, commercial for enterprise features |
| [graphology](https://github.com/graphology/graphology) + subpackages | JS/TS | last release ~April 2025, 272 dependents | Embeddable in Orbit's Node stack, TypeScript-native | Smaller algo library than GDS |
| [networkx](https://networkx.org/) | Python | very active | Broadest algo coverage | Python, slow on 100k+ nodes |
| [igraph](https://igraph.org/) | C w/ Python/R bindings | very active | Fast, implements Leiden canonically | Not Node |
| [graph-tool](https://graph-tool.skewed.de/) | C++ w/ Python | active | Fastest CPU-bound, stochastic block models | Painful install, Python-only |
| [cuGraph](https://github.com/rapidsai/cugraph) | GPU / Python | active (NVIDIA) | 8.8× faster than igraph's Leiden on a citation graph per NVIDIA blog | Requires CUDA GPU — off-table for Orbit |

**Verdict:** Orbit already has Neo4j Aura in the stack. Running Louvain / Leiden / PageRank server-side via GDS is the cheap path. For the preview viz (reagraph on the client), mirroring community IDs into the node payload is trivial — either compute them in Neo4j and pass them through, or compute in Node with `graphology-communities-louvain` from the same data.

### 3.2 What each algorithm unlocks for Orbit

- **Louvain / Leiden.** Partitions 6,809 into natural clusters on the co-presence graph (shared WA groups, Gmail threads, cal events): "Mumbai-tech", "Dubai-founders", "Cursor-India", "college batch". Directly feeds discovery — "show me the cluster I haven't touched in 90 days." Leiden strictly dominates Louvain on well-connectedness + speed (Traag 2019).
- **PageRank / eigenvector centrality.** Who's the hub — whose introduction carries transitive reach. Weighted degree + neighbor quality.
- **Betweenness centrality.** Bridges between otherwise-disconnected components. **High signal for "introduce X to Y."** O(VE) but 6,809 is trivially small.
- **Node embeddings** (Node2Vec, FastRP, GraphSAGE — all in GDS). Dense vectors per person capturing structural role. Enables "find people similar to Ramon" without manual tags.
- **Bridge detection / structural holes** (Burt 1992). Edge betweenness / edge weight. Flag for later.

**Key paper:** Traag, Waltman, van Eck, *From Louvain to Leiden*, Nature Sci Reports 9:5233 (2019).

---

## 4. Relationship scoring / tie strength

### 4.1 The academic grounding

- **Granovetter (1973), *The Strength of Weak Ties*.** Foundational definition: tie strength = time + emotional intensity + intimacy + reciprocal services.
- **Gilbert & Karahalios, CHI 2009, [Predicting Tie Strength With Social Media](http://eegilbert.org/papers/chi09.tie.gilbert.pdf).** 2,184 Facebook ties, 32/70 features retained. **>85% accuracy** on strong vs weak. Feature importance: **Intimacy 32.8%, Intensity 19.7%, duration 16.5%.** Orbit mappings: intensity = message counts, duration = days-since-first-contact, intimacy ≈ media-type mix (voice > text) + emoji diversity.
- **Levin, Walter, Murnighan, Organization Science 2011, [Dormant Ties](https://business.gwu.edu/sites/g/files/zaxdzs5326/files/15_FP.SP_Walter.J_15levin_2011a.pdf).** The thesis Orbit is built on. Reconnected dormant ties outperform current ties on trust, novelty, efficiency. Typical ≥10 useful dormant ties per person — why discovery (not top-N) is the right frame.
- **Oettershagen et al., [*Inferring Tie Strength in Temporal Networks*](https://arxiv.org/abs/2206.11705) (2022).** Temporal features (inter-event times, burstiness) beat raw counts. Argument for decay-weighted scores.
- **[*Calling Dunbar's Numbers*](https://arxiv.org/abs/1604.02400) (2016).** Validates 5/15/50/150 layers on phone-call data. For Orbit, a **calibration target** — if top-5-by-score doesn't match Sanchay's inner-circle intuition, weights are wrong.

### 4.2 OSS implementations

- Not much. Tie strength is mostly published-as-formula, not published-as-library.
- [complex-network-link-prediction](https://github.com/Typing-Monkeys/complex-network-link-prediction) — Python library with Adamic/Adar, Jaccard, Common Neighbors, Katz, Preferential Attachment, Friend-TNS. Useful for "who should I know" rather than "how close am I to X."
- Neo4j GDS has link prediction (Adamic/Adar, Common Neighbors, Preferential Attachment) as Cypher procedures. Same calculations, already in-stack.
- **No existing library wraps the Gilbert feature set.** Implement ourselves.

### 4.3 Recommended scorer for Orbit (concrete)

Per-person per-channel features, then a weighted sum. ~200 LOC in TS.

```
score(person) = Σ_channel w_channel × [
    α · log(1 + message_count_30d)
  + β · log(1 + days_since_first_contact / 30)
  + γ · reciprocity_ratio                  // 0 if pure fan-out, 1 if balanced
  + δ · recency_decay(last_contact)        // exp(-days/τ), τ ≈ 45
  + ε · media_mix_bonus                    // voice/video > text > reaction
]
```

The `recency_decay` with half-life τ ≈ 45 days is the "going cold" signal. `reciprocity_ratio` matters — broadcast groups shouldn't inflate tie strength.

---

## 5. Local-first / CRDT

Not V0 — keep flagged for V2 (multi-founder or offline Claw).

- **[Automerge](https://automerge.org/)** — v3.0 cut memory 10× (Rust core, WASM bindings). JSON data model fits Orbit packets cleanly. `automerge-repo` handles sync.
- **[Yjs](https://github.com/yjs/yjs)** — wider adoption (JupyterLab, etc.), huge provider ecosystem (y-webrtc, y-indexeddb, hocuspocus). Better for collab text than doc sync.
- **[Loro](https://loro.dev/)** — newer, Rust-based, benchmarks well. Too young to bet on.
- **[RxDB](https://rxdb.info/)** — not strictly CRDT; LWW default w/ custom handlers. "Local DB with sync" category.
- **Logux** — Redux-flavored action-log sync. Couldn't verify 2025 maintenance.

**For Orbit:** the sync model is founder ↔ central API, not peer-to-peer. That's CQRS/event-sourcing more than CRDT — the `raw_events` ledger already is an event log. Automerge only earns its keep if founders merge *packets* locally before syncing up.

---

## 6. LLM-based matching

### 6.1 Key papers

- Peeters & Bizer, [*Entity Matching using LLMs*](https://arxiv.org/abs/2310.11244) (2023) — GPT-4 hits SOTA without task-specific training; prompt format matters.
- [*Cost-efficient prompt engineering for unsupervised ER*](https://arxiv.org/html/2310.06174v2) (2023) — 6 prompt strategies on GPT-3.5. **More complex ≠ better.** Simple structured prompts + CoT win on cost/F1.
- Wang et al., [*Match, Compare, or Select? (ComEM)*](https://arxiv.org/abs/2405.16884) (2024) — compound framework. "Select" (pick 1 of K candidates) is far cheaper than pairwise "match" given a blocking step.
- Fine-tuning for EM: arxiv [2409.08185](https://arxiv.org/abs/2409.08185) — helps small models, hurts cross-domain transfer. Not worth it at Orbit's scale.

### 6.2 Hybrid rule+LLM — Orbit's Layer 3 direction

Consistent pattern across 2024-25 work: (1) deterministic blocking, (2) deterministic match for obvious cases, (3) LLM only for the ambiguous tail. **This is exactly Orbit's L1/L2/L3 plan — don't get seduced into LLM-first.**

### 6.3 Cost envelope

Post-L1/L2, ambiguous pairs at 6,809 persons ≈ 50-500. At ~$0.003/pair (GPT-4o-mini, batched, structured output) that's $0.15-$1.50 per full reconciliation. Cost is not the constraint; quality + provenance are.

### 6.4 OSS frameworks

- LangChain has no first-party ER chain — roll your own prompt + structured output + retry.
- DSPy / Pydantic-AI give better type-safety than raw SDK calls.
- [pyJedAI](https://github.com/AI-team-UoA/pyJedAI) — Python, integrates LLMs into an ER pipeline.

---

## 7. Messaging / channel tooling

| Library | Lang | Status | Protocol | Note |
|---|---|---|---|---|
| [whatsmeow](https://github.com/tulir/whatsmeow) | Go | very active (`go.mau.fi/whatsmeow` is canonical) | WA multi-device | What wacli already uses. Ported from Baileys. MIT. |
| [Baileys](https://github.com/WhiskeySockets/Baileys) | TS/Node | active, popular | WA web | Node-native alternative. Use if OpenClaw grows a Node skill. |
| [whatsapp-rust](https://github.com/jlucaso1/whatsapp-rust) | Rust | early | WA | Experimental, not production. |
| [signal-cli](https://github.com/AsamK/signal-cli) | Java | active (`AsamK/signal-cli`) | Signal | CLI + JSON-RPC + dbus. Path to a Signal channel for V2. |
| [imessage-tools](https://github.com/my-other-github-account/imessage_tools) | Python | maintained | reads `chat.db` + handles `attributedBody` | Best choice when iMessage is unlocked post-V0. Single-file. |
| [imessage-reader](https://pypi.org/project/imessage-reader/) | Python | maintained | reads `chat.db` | Simpler, no send capability. |
| [vcf (node-vcf)](https://www.npmjs.com/package/vcf) | JS | v2.1.2, 24 dependents | vCard parse/construct | The one pick for vCard. 6350/6351/7095 compliant. |

**Takeaway:** the messaging layer is well-covered for channels Orbit cares about. OpenClaw + wacli + whatsmeow is already the best-available path for WhatsApp; Signal and iMessage have obvious library choices when they come up.

---

## 8. Contact deduplication specifically

### 8.1 Google Contacts / iCloud CardDAV dedup

Neither is documented. Observable behavior suggests three deterministic signals: email normalization (case-fold + gmail dot-strip), E.164 phone canonicalization, graph proximity (shared calendar events / mutual emails). Precision-biased — refuses to merge two different "Sarah Chen"s with different orgs, matching Orbit's 0-wrong-merges posture. Third-party dedup tools (Gemini, Cisdem) appear to use similar signals + photo hash.

### 8.2 Libraries

- [vcf](https://www.npmjs.com/package/vcf) — vCard parser, Node.
- [libphonenumber-js](https://github.com/catamphetamine/libphonenumber-js) — already in Orbit, still the best JS port.
- Email normalization — Orbit's current `+suffix` strip + gmail-dot collapse is correct; no library needed.
- [libpostal](https://github.com/openvenues/libpostal) — international-address NER. Overkill unless we add a location axis.

### 8.3 Dating-app identity matching

Proprietary, not documented. Directional signals visible in public research: device fingerprint, photo embedding (FaceNet/ArcFace), bio-text embedding. Photo embedding is interesting long-term (match a WA avatar to LinkedIn) but blocked on a consent model.

---

## 9. Concrete opportunities for Orbit

Prioritized by "shortest path to a visible product improvement." Each one is scoped tightly enough to execute in a single session.

### Opportunity 1 — Leiden community detection via Neo4j GDS, piped into the viz

- **Why.** Orbit already has the Neo4j graph. Today the preview viz shows co-presence edges as undifferentiated lines. Louvain/Leiden partitions 6,809 into ~30-80 communities — instantly readable "Cursor India crowd / Mumbai founders / Dubai startup / IIT batch" regions. This is the single highest-signal UX upgrade available. It's exactly the "discovery, not directory" pitch from the project notes.
- **What.** `CALL gds.leiden.write(...)` computes a `community_id` per node; `scripts/build-network-viz.mjs` already produces the viz data, so we add the property to the node payload and color by it in reagraph.
- **Integration cost.** Half a day. GDS plugin may need to be enabled on the Aura instance (check tier). Leiden is preferred over Louvain — same API, guaranteed well-connected communities, per Traag 2019.
- **Risk.** Community boundaries are fuzzy; modularity scores can jitter run-to-run. Mitigation: run Leiden with fixed seed + report the modularity score in the viz metadata so we know when a partition is stable vs unstable.
- **Paper:** Traag/Waltman/van Eck, Nature Sci Reports 9:5233 (2019).

### Opportunity 2 — Replace token-fuzzy name bridge with `pg_trgm` + Double Metaphone, using Splink-style weights

- **Why.** Layer 2 is the weakest link in the current identity stack — it's "simple token-based match with a threshold." This is the place we'd burn 20% of our future time on "why did these two people not merge / why did these merge wrongly." Replacing it cleanly before more data arrives is the highest-leverage deterministic win.
- **What.** 
  - Enable `pg_trgm` and `fuzzystrmatch` on Supabase (both ship free, no extra dependency).
  - Build a `person_name_candidates` view: for each pair sharing a prefix bucket, compute `similarity(name_a, name_b)` (trigram), `levenshtein`, and `dmetaphone(name_a) = dmetaphone(name_b)`.
  - Combine with Fellegi-Sunter-style match weights (log2(match-rate / non-match-rate per feature) — Splink's whole approach) to produce a single calibrated score.
- **Integration cost.** 1-2 days, stays in Postgres, no Python sidecar. Key unlock: we don't adopt Splink-the-library, we adopt Splink-the-model in SQL. Robin Linacre's posts and the Splink docs give the calibration methodology.
- **Risk.** pg_trgm is ASCII/Unicode-naive — non-Latin names (Devanagari, Arabic, Mandarin) behave poorly. We keep LID→phone and email-domain deterministic paths for those, and only escalate to Layer 3 (LLM) for the ambiguous tail.
- **Benchmark target.** Audit 50 new merges post-change; keep wrong-merge count at 0 while closing 5+ specific "should have merged but didn't" misses from today's set.

### Opportunity 3 — Gilbert-style tie-strength scorer with 45-day recency decay

- **Why.** The dashboard today surfaces persons but doesn't rank them by Sanchay's relationship temperature. Without a score, "going cold" and "who to reconnect with" are unimplementable. This is the smallest-possible backbone for every downstream discovery UX.
- **What.** Implement the score from §4.3 as a single TS function over `raw_events` + `interactions`. Runs per-person on demand or cached in `persons.tie_strength`. Features: message_count_30d, days_since_first_contact, reciprocity_ratio, recency_decay, media_mix_bonus — per channel, weighted sum.
- **Integration cost.** ~200 LOC, 1 day including tests. All inputs already exist in the ledger.
- **Risk.** Weights will be wrong initially. Mitigation: calibrate against Sanchay's own ranking of his top-20 known people. If top-5-by-score doesn't match his inner circle intuition, weights get tuned. Dunbar's 5/15/50/150 is the sanity check.
- **Paper:** Gilbert & Karahalios CHI 2009; Oettershagen et al. arxiv 2206.11705 for temporal features.

### Opportunity 4 — Dormant-tie surfacing: "people you haven't messaged in 90+ days but who were strong ties"

- **Why.** Direct product-market fit for Orbit's core thesis ("show me who I forgot"). Drops out of Opportunity 3 almost for free — dormant ties are just `max_score_over_history - current_score > threshold`. Levin et al. (Org Science 2011) is the academic backbone: dormant ties reconnect with all four benefits of both weak and strong ties, and a typical person has ≥10 useful ones.
- **What.** A `GET /api/v1/persons/dormant?days=90` endpoint that returns persons whose peak 30-day message count was > 20 AND whose last_contact is > 90 days ago. Rank by peak × recency_decay_inverse so higher-peak older-silence rises.
- **Integration cost.** Half a day once Opportunity 3 lands. Pure SQL query over the projection.
- **Risk.** False positives when someone legitimately ended a relationship. Mitigation: add a `snoozed_until` on observation so Sanchay can dismiss.
- **Paper:** Levin, Walter, Murnighan, Organization Science 22(4), 2011.

### Opportunity 5 — Node-side mirror of GDS algos via `graphology` for preview / future offline

- **Why.** Keeps the server-compute path in Neo4j but gives us a lightweight Node fallback so the preview viz script doesn't hard-depend on Aura being up. Also positions for future OpenClaw-side partial graph analysis without a round trip.
- **What.** Add `graphology` + `graphology-communities-louvain` + `graphology-metrics` as deps. Build a tiny adapter that reads the same node/edge payload already produced by `scripts/build-network-viz.mjs` and runs Louvain client-side. Use it for the viz layer; keep GDS as server-of-record for persistence.
- **Integration cost.** ~4 hours. Graphology's API is TypeScript-native and matches our stack.
- **Risk.** Duplication — two code paths computing communities. Mitigation: make the Node version strictly "preview only, not written back"; canonical truth lives in Neo4j.
- **Last release note.** graphology v0.26.0 was the latest as of the April 2025 npm listing. Still maintained but not frequent — if we hit a bug the ecosystem is small enough that we'd likely patch it ourselves. Flag for re-evaluation before committing to it for anything load-bearing beyond viz.

---

## 10. Sources and references

**Entity resolution libraries**
- Splink: https://github.com/moj-analytical-services/splink · docs https://moj-analytical-services.github.io/splink/
- dedupe: https://github.com/dedupeio/dedupe · docs https://docs.dedupe.io/
- Zingg: https://github.com/zinggAI/zingg
- RLTK: https://github.com/usc-isi-i2/rltk · docs https://rltk.readthedocs.io/
- recordlinkage: https://github.com/J535D165/recordlinkage
- py_entitymatching: https://github.com/anhaidgroup/py_entitymatching
- pyJedAI: https://github.com/AI-team-UoA/pyJedAI
- Awesome Entity Resolution (index): https://github.com/OlivierBinette/Awesome-Entity-Resolution

**Blocking / ANN**
- Papadakis et al., *Benchmarking Filtering Techniques for Entity Resolution*, arxiv [2202.12521](https://arxiv.org/abs/2202.12521)
- BlockingPy, arxiv [2504.04266](https://arxiv.org/html/2504.04266)
- Neural LSH for Entity Blocking, arxiv [2401.18064](https://arxiv.org/pdf/2401.18064)

**String similarity**
- jellyfish: https://github.com/jamesturk/jellyfish
- talisman (Node): https://github.com/Yomguithereal/talisman
- pg_trgm: https://www.postgresql.org/docs/current/pgtrgm.html
- fuzzystrmatch: https://www.postgresql.org/docs/current/fuzzystrmatch.html

**Graph libraries / algorithms**
- Neo4j GDS Louvain: https://neo4j.com/docs/graph-data-science/current/algorithms/louvain/
- Neo4j GDS Leiden: https://neo4j.com/docs/graph-data-science/current/algorithms/leiden/
- graphology: https://github.com/graphology/graphology
- graphology-communities-louvain: https://www.npmjs.com/package/graphology-communities-louvain
- networkx: https://networkx.org/
- igraph: https://igraph.org/
- graph-tool: https://graph-tool.skewed.de/
- cuGraph Leiden benchmark: https://developer.nvidia.com/blog/how-to-accelerate-community-detection-in-python-using-gpu-powered-leiden/
- Traag, Waltman, van Eck, *From Louvain to Leiden*, Nature Sci Reports 9:5233 (2019), https://www.nature.com/articles/s41598-019-41695-z

**Tie strength / dormant ties / Dunbar**
- Gilbert & Karahalios, CHI 2009: http://eegilbert.org/papers/chi09.tie.gilbert.pdf
- Levin, Walter, Murnighan, *Dormant Ties*, Organization Science 22(4) 2011: https://business.gwu.edu/sites/g/files/zaxdzs5326/files/15_FP.SP_Walter.J_15levin_2011a.pdf
- Oettershagen et al., *Inferring Tie Strength in Temporal Networks*, arxiv [2206.11705](https://arxiv.org/abs/2206.11705)
- *Calling Dunbar's Numbers*, arxiv [1604.02400](https://arxiv.org/abs/1604.02400)

**LLM entity matching**
- Peeters & Bizer, arxiv [2310.11244](https://arxiv.org/abs/2310.11244)
- Cost-efficient prompt engineering for ER, arxiv [2310.06174](https://arxiv.org/html/2310.06174v2)
- Wang et al., *Match, Compare, or Select? (ComEM)*, arxiv [2405.16884](https://arxiv.org/abs/2405.16884)
- Fine-tuning LLMs for EM, arxiv [2409.08185](https://arxiv.org/abs/2409.08185)
- In-context Clustering-based ER, arxiv [2506.02509](https://arxiv.org/html/2506.02509v1)

**Local-first / CRDT**
- Automerge: https://automerge.org/ · v3.0 memory note https://automerge.org/blog/automerge-3/
- Yjs: https://github.com/yjs/yjs
- Loro: https://loro.dev/
- RxDB: https://rxdb.info/
- CRDT benchmarks: https://github.com/dmonad/crdt-benchmarks

**Messaging tooling**
- whatsmeow: https://github.com/tulir/whatsmeow (canonical `go.mau.fi/whatsmeow`)
- Baileys: https://github.com/WhiskeySockets/Baileys
- signal-cli: https://github.com/AsamK/signal-cli
- imessage-tools: https://github.com/my-other-github-account/imessage_tools
- imessage-reader: https://pypi.org/project/imessage-reader/
- vcf (node): https://www.npmjs.com/package/vcf
- libpostal: https://github.com/openvenues/libpostal

**Items I couldn't fully verify**
- Specific ranking weights / daily-batch cadence claims in Google Contacts dedup — behavior is observable but the internals are not published by Google. Treat §8.1 as best-guess, not authoritative.
- Logux activity in 2025 — search returned older references. If considered for V2, re-verify maintenance.
- Dating-app identity-matching internals — proprietary, referenced here only as directional signal (photo-embedding + bio-embedding are likely ingredients, not confirmed).
