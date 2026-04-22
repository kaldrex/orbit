#!/usr/bin/env node
// Read manifest NDJSON (from manifest-gen.mjs) → write observation envelope NDJSON.
// Usage: cat manifest.ndjson | node manifest-to-observations.mjs > observations.ndjson
import { createInterface } from "node:readline";

const REINGEST_SCHEME = process.env.REINGEST_SCHEME || "reingest-20260422";
const OBSERVER = process.env.OBSERVER || "chad"; // must match OBSERVERS enum in src/lib/observations-schema.ts
const rl = createInterface({ input: process.stdin });

const provenanceToSources = (p) => {
  const active = Object.entries(p).filter(([, v]) => v).map(([k]) => k);
  return active.length ? active.join("+") : "unknown";
};

function bestName(m) {
  if (m.name && typeof m.name === "string" && m.name.trim()) return m.name.trim();
  if (Array.isArray(m.emails) && m.emails[0]) return m.emails[0].split("@")[0];
  if (Array.isArray(m.phones) && m.phones[0]) return m.phones[0];
  return "unknown";
}

for await (const line of rl) {
  const t = line.trim();
  if (!t) continue;
  const m = JSON.parse(t);
  const sources = provenanceToSources(m.source_provenance || {});
  const obs = {
    kind: "person",
    observer: OBSERVER,
    observed_at: m.first_seen || new Date().toISOString(),
    confidence: 1,
    reasoning: `Derived from deterministic manifest generation across ${sources}. Rules-only, per phone/email/LID union-find.`,
    evidence_pointer: `${REINGEST_SCHEME}://${m.id}`,
    dedup_key: `person-manifest:${m.id}`,
    payload: {
      name: bestName(m),
      title: null,
      emails: Array.isArray(m.emails) ? m.emails : [],
      phones: Array.isArray(m.phones) ? m.phones : [],
      company: null,
      category: "other",
      relationship_to_me: "",
    },
  };
  process.stdout.write(JSON.stringify(obs) + "\n");
}
