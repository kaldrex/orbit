// Group-level junk classification. Advisory, not auto-exclusion.
//
// Per agent-docs/12-junk-filtering-system.md §Layer-1:
//
//   - mega-lurker    : member_count > 200 AND self_outbound_count === 0
//   - broadcast-ratio: top sender > 80% of total, total > 10
//   - commercial     : group name matches a sale/deal/crypto/giveaway regex
//
// The aggregator `classifyGroup()` returns {junk, reasons[], max_confidence}.
// Consumers (manifest-gen, Phase C) annotate groups but do NOT exclude.
// Layer 2 (blocklist table) and Layer 3 (self-writing heuristics) will
// arrive in a later cycle.

const COMMERCIAL_RE =
  /\b(sale|sales|deal|deals|offer|offers|crypto|giveaway|giveaways|coupon|coupons|promo|promos|discount|discounts|airdrop|airdrops|signup bonus|referral|referrals)\b/i;

export function isMegaLurkerGroup({ member_count, self_outbound_count }) {
  const mc = Number(member_count ?? 0);
  const so = Number(self_outbound_count ?? 0);
  if (mc > 200 && so === 0) {
    return { junk: true, reason: "mega_lurker", confidence: 0.85 };
  }
  return { junk: false, reason: null, confidence: 0 };
}

export function isBroadcastRatioGroup({ sender_counts }) {
  if (!sender_counts || typeof sender_counts !== "object") {
    return { junk: false, reason: null, confidence: 0 };
  }
  const counts = Object.values(sender_counts)
    .map((v) => Number(v ?? 0))
    .filter((n) => Number.isFinite(n) && n > 0);
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 10) return { junk: false, reason: null, confidence: 0 };
  const max = Math.max(...counts, 0);
  const ratio = total > 0 ? max / total : 0;
  if (ratio > 0.8) {
    return { junk: true, reason: "broadcast_ratio", confidence: 0.75 };
  }
  return { junk: false, reason: null, confidence: 0 };
}

export function isCommercialKeywordGroup({ group_name }) {
  if (typeof group_name !== "string" || !group_name) {
    return { junk: false, reason: null, confidence: 0 };
  }
  if (COMMERCIAL_RE.test(group_name)) {
    return { junk: true, reason: "commercial_keyword", confidence: 0.65 };
  }
  return { junk: false, reason: null, confidence: 0 };
}

/**
 * Aggregator. Returns {junk, reasons[], max_confidence}.
 *
 * @param {{member_count?: number, self_outbound_count?: number,
 *          sender_counts?: Record<string, number>, group_name?: string}} ctx
 */
export function classifyGroup(ctx = {}) {
  const checks = [
    isMegaLurkerGroup(ctx),
    isBroadcastRatioGroup(ctx),
    isCommercialKeywordGroup(ctx),
  ];
  const hits = checks.filter((c) => c.junk);
  if (hits.length === 0) {
    return { junk: false, reasons: [], max_confidence: 0 };
  }
  return {
    junk: true,
    reasons: hits.map((c) => c.reason),
    max_confidence: Math.max(...hits.map((c) => c.confidence)),
  };
}
