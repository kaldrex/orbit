// Nightly job: expands the @lid→phone map.
// Track 1 scope = scaffolding only: seed application + name-token candidate
// generator. Later tracks wire up group co-occurrence and push_name signals.

const MIN_CONFIDENCE = 0.8;

export function applySeed(seed) {
  const accepted = [];
  const rejected = [];
  for (const p of seed.pairs || []) {
    if (typeof p.confidence !== "number" || p.confidence < MIN_CONFIDENCE) {
      rejected.push({ ...p, reject_reason: "confidence_below_threshold" });
      continue;
    }
    accepted.push(p);
  }
  return { pairs_applied: accepted.length, rejected, pairs: accepted };
}

function tokenize(s) {
  return String(s || "")
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ""))
    .filter((t) => t.length >= 2);
}

export function bridgeLid(contacts, { minTokens = 2 } = {}) {
  const lids = contacts.filter((c) => String(c.jid).endsWith("@lid"));
  const phones = contacts.filter((c) =>
    String(c.jid).endsWith("@s.whatsapp.net"),
  );
  const out = [];
  for (const l of lids) {
    const lt = new Set(tokenize(l.push_name));
    for (const p of phones) {
      const pt = new Set([
        ...tokenize(p.full_name),
        ...tokenize(p.push_name),
        ...tokenize(p.first_name),
      ]);
      const common = [...lt].filter((t) => pt.has(t));
      if (common.length >= 1) {
        out.push({
          lid: l.jid,
          phone: p.phone || p.jid,
          confidence: common.length >= minTokens ? 0.9 : 0.6,
          reason: "name_token_overlap",
          tokens: common,
        });
      }
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import("node:fs");
  const seedPath = process.env.LID_SEED || "tests/fixtures/lid-seed.json";
  const seed = JSON.parse(readFileSync(seedPath, "utf8"));
  console.log(JSON.stringify(applySeed(seed), null, 2));
}
