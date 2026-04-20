// Layer 2 cross-channel fuzzy-name bridge.
//
// After the Layer-1 rule-based union-find finishes (phone/email/lid exact-
// match joins), some humans still appear as two separate buckets because
// the rule-layer can't bridge phone↔email. Classic case: Umayr on WhatsApp
// (+971586783040) and Umayr on Gmail (usheik@sinxsolutions.ai). Both
// buckets carry a "Umayr Sheik" name.
//
// This pass scans WA-only buckets against Gmail-only buckets and merges
// when the names fuzzy-match above a threshold. Guards:
//   - Names must be non-empty and non-generic (blocklist of short first
//     names handles "John" / "Mike" style ambiguity).
//   - When the name is a single token, we require >= 0.92 JW — too much
//     risk of merging different "Umayr"s.
//   - When the name has 2+ tokens, fuzzyMatch's token-set score carries
//     more signal — we allow 0.85.
//
// Pure function: takes a list of buckets, returns merge-pair advice.
// Caller applies the merges via its own union-find.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { fuzzyMatch } from "./fuzzy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = JSON.parse(
  readFileSync(path.join(HERE, "..", "data", "domains.json"), "utf8"),
);

const GENERIC_FIRST_NAMES = new Set(
  (CORPUS.generic_first_names ?? []).map((s) => s.toLowerCase()),
);
const SAAS_VENDOR_NAMES = new Set(
  (CORPUS.saas_vendor_names ?? []).map((s) => s.toLowerCase()),
);

function normalizeName(s) {
  return (s ?? "")
    .toString()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s) {
  return normalizeName(s).split(" ").filter(Boolean);
}

// Decide whether a (bucket_A, bucket_B) pair may merge on name similarity.
// Buckets are opaque to this function — we only inspect .provenance (Set or
// array), .name, .phones, .emails.
function provSet(b) {
  if (!b) return new Set();
  if (b.provenance instanceof Set) return b.provenance;
  return new Set(b.provenance || []);
}
// "WA side" = has at least one WA/Google-Contact signal and NO gmail signal.
// Google Contacts is phone-keyed in Sanchay's corpus; buckets that came in
// via Google Contacts + WhatsApp are still on the WA side of the bridge.
// "Gmail side" is the mirror: gmail signal with no WA / google_contact.
function hasOnlyWaSources(b) {
  const p = provSet(b);
  if (!p.size) return false;
  if (p.has("gmail_from") || p.has("gmail_to_cc")) return false;
  return (
    p.has("wa_dm") ||
    p.has("wa_contact") ||
    p.has("wa_group") ||
    p.has("google_contact")
  );
}
function hasOnlyGmailSources(b) {
  const p = provSet(b);
  if (!p.size) return false;
  if (p.has("wa_dm") || p.has("wa_contact") || p.has("wa_group")) return false;
  if (p.has("google_contact")) return false;
  return p.has("gmail_from") || p.has("gmail_to_cc");
}

function isGenericName(name) {
  const toks = tokens(name);
  if (!toks.length) return true;
  // Single-token name that is short (< 4 chars) or in the generic-name
  // blocklist → generic.
  if (toks.length === 1) {
    const t = toks[0];
    if (t.length < 4) return true;
    if (GENERIC_FIRST_NAMES.has(t)) return true;
    // SaaS vendor name (Amazon, Google, Stripe etc.) as a single-token WA
    // label is almost certainly a bot-number shortcut, not a real human.
    if (SAAS_VENDOR_NAMES.has(t)) return true;
  }
  // Full normalized name exactly matches a SaaS vendor → block
  const full = normalizeName(name);
  if (SAAS_VENDOR_NAMES.has(full)) return true;
  // Any token in a short name is a vendor (e.g. "Amazon.in" → tokens "amazon","in")
  if (toks.length <= 2) {
    for (const t of toks) if (SAAS_VENDOR_NAMES.has(t)) return true;
  }
  return false;
}

export function decideCrossChannelMerge({
  bucket_a,
  bucket_b,
  threshold = 0.85,
  single_token_threshold = 0.92,
}) {
  if (!bucket_a || !bucket_b) {
    return { merge: false, score: 0, reason: "missing bucket" };
  }
  if (!bucket_a.name || !bucket_b.name) {
    return { merge: false, score: 0, reason: "missing name" };
  }
  // Symmetric: one side must be WA-only, the other Gmail-only.
  const aWa = hasOnlyWaSources(bucket_a);
  const bWa = hasOnlyWaSources(bucket_b);
  const aGmail = hasOnlyGmailSources(bucket_a);
  const bGmail = hasOnlyGmailSources(bucket_b);

  const waSide = aWa ? bucket_a : bWa ? bucket_b : null;
  const gmailSide = aGmail ? bucket_a : bGmail ? bucket_b : null;
  if (!waSide || !gmailSide || waSide === gmailSide) {
    return { merge: false, score: 0, reason: "not a WA/Gmail pair" };
  }

  if (isGenericName(waSide.name) || isGenericName(gmailSide.name)) {
    return { merge: false, score: 0, reason: "generic name" };
  }

  const { score } = fuzzyMatch({
    name_a: waSide.name,
    name_b: gmailSide.name,
  });

  // Pick threshold based on token counts.
  const minTokens = Math.min(
    tokens(waSide.name).length,
    tokens(gmailSide.name).length,
  );
  const cutoff = minTokens >= 2 ? threshold : single_token_threshold;

  if (score < cutoff) {
    return { merge: false, score, reason: `below cutoff ${cutoff}` };
  }

  // If both sides have 2+ tokens, require the first token to match exactly
  // after normalization, or at least one shared token — this prevents
  // "Umayr Sheik" + "Umayr Khan" from merging on token-set alone.
  const aTok = tokens(waSide.name);
  const bTok = tokens(gmailSide.name);
  if (aTok.length >= 2 && bTok.length >= 2) {
    const aSet = new Set(aTok);
    let shared = 0;
    for (const t of bTok) if (aSet.has(t)) shared++;
    if (shared < 2) {
      return { merge: false, score, reason: "multi-token but <2 shared" };
    }
  }

  return {
    merge: true,
    score,
    reason: `fuzzy ${score} >= ${cutoff}`,
    wa_side_key: waSide.id ?? waSide.root ?? null,
    gmail_side_key: gmailSide.id ?? gmailSide.root ?? null,
  };
}

// Convenience: scan a list of buckets, return all pairs to merge.
// Buckets that already merged are not re-considered (first-match wins).
export function crossChannelBridge({ buckets, threshold, single_token_threshold }) {
  const waBuckets = [];
  const gmailBuckets = [];
  for (const b of buckets) {
    if (hasOnlyWaSources(b)) waBuckets.push(b);
    else if (hasOnlyGmailSources(b)) gmailBuckets.push(b);
  }
  const merged = new Set();
  const pairs = [];
  for (const a of waBuckets) {
    if (!a.name) continue;
    if (merged.has(a.root ?? a.id)) continue;
    let best = null;
    for (const b of gmailBuckets) {
      if (!b.name) continue;
      if (merged.has(b.root ?? b.id)) continue;
      const d = decideCrossChannelMerge({
        bucket_a: a,
        bucket_b: b,
        threshold,
        single_token_threshold,
      });
      if (d.merge && (!best || d.score > best.decision.score)) {
        best = { a, b, decision: d };
      }
    }
    if (best) {
      pairs.push({
        wa_key: best.a.root ?? best.a.id,
        gmail_key: best.b.root ?? best.b.id,
        score: best.decision.score,
        reason: best.decision.reason,
      });
      merged.add(best.a.root ?? best.a.id);
      merged.add(best.b.root ?? best.b.id);
    }
  }
  return pairs;
}
