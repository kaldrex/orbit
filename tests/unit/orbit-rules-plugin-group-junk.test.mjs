import { describe, it, expect } from "vitest";

import {
  isMegaLurkerGroup,
  isBroadcastRatioGroup,
  isCommercialKeywordGroup,
  classifyGroup,
} from "../../orbit-rules-plugin/lib/group-junk.mjs";

describe("isMegaLurkerGroup", () => {
  it("flags >200 members with 0 self outbound", () => {
    const r = isMegaLurkerGroup({ member_count: 247, self_outbound_count: 0 });
    expect(r.junk).toBe(true);
    expect(r.reason).toBe("mega_lurker");
    expect(r.confidence).toBe(0.85);
  });

  it("does NOT flag a small group with 0 outbound", () => {
    const r = isMegaLurkerGroup({ member_count: 5, self_outbound_count: 0 });
    expect(r.junk).toBe(false);
  });

  it("does NOT flag a large group where Sanchay participates", () => {
    const r = isMegaLurkerGroup({ member_count: 500, self_outbound_count: 3 });
    expect(r.junk).toBe(false);
  });

  it("boundary: exactly 200 members is NOT flagged", () => {
    const r = isMegaLurkerGroup({ member_count: 200, self_outbound_count: 0 });
    expect(r.junk).toBe(false);
  });

  it("returns shape with nulls when not junk", () => {
    const r = isMegaLurkerGroup({ member_count: 10, self_outbound_count: 0 });
    expect(r.reason).toBeNull();
    expect(r.confidence).toBe(0);
  });
});

describe("isBroadcastRatioGroup", () => {
  it("flags top sender > 80% with total > 10", () => {
    const r = isBroadcastRatioGroup({
      sender_counts: { A: 85, B: 10, C: 5 },
    });
    expect(r.junk).toBe(true);
    expect(r.reason).toBe("broadcast_ratio");
  });

  it("does NOT flag below-threshold ratio", () => {
    const r = isBroadcastRatioGroup({
      sender_counts: { A: 50, B: 30, C: 20 },
    });
    expect(r.junk).toBe(false);
  });

  it("does NOT flag when total <= 10 (size gate)", () => {
    const r = isBroadcastRatioGroup({
      sender_counts: { A: 8, B: 1, C: 1 },
    });
    expect(r.junk).toBe(false);
  });

  it("handles missing/empty sender_counts", () => {
    expect(isBroadcastRatioGroup({}).junk).toBe(false);
    expect(isBroadcastRatioGroup({ sender_counts: null }).junk).toBe(false);
  });
});

describe("isCommercialKeywordGroup", () => {
  it("flags 'BTC Giveaway'", () => {
    expect(isCommercialKeywordGroup({ group_name: "BTC Giveaway" }).junk).toBe(
      true,
    );
  });
  it("flags 'Forsage Deals'", () => {
    expect(isCommercialKeywordGroup({ group_name: "Forsage Deals" }).junk).toBe(
      true,
    );
  });
  it("flags 'Mega Sale Alerts'", () => {
    expect(
      isCommercialKeywordGroup({ group_name: "Mega Sale Alerts" }).junk,
    ).toBe(true);
  });
  it("flags 'Crypto Signup Bonus'", () => {
    expect(
      isCommercialKeywordGroup({ group_name: "Crypto Signup Bonus" }).junk,
    ).toBe(true);
  });
  it("flags clean business names as junk (documented current behavior, false positive risk)", () => {
    // DOCUMENTED: the regex matches "deal" inside "Deal Team — Acme Co"
    // (\b matches word boundaries). This is a known over-match that Layer
    // 2 (reviewer blocklist) is expected to correct. We do NOT auto-exclude
    // based on this signal — classifyGroup is advisory.
    expect(
      isCommercialKeywordGroup({ group_name: "Deal Team — Acme Co" }).junk,
    ).toBe(true);
    expect(
      isCommercialKeywordGroup({ group_name: "Crypto Thesis Book Club" })
        .junk,
    ).toBe(true);
  });
  it("does NOT flag a truly neutral name", () => {
    expect(
      isCommercialKeywordGroup({ group_name: "Umayr ↔ Sanchay" }).junk,
    ).toBe(false);
  });
  it("handles empty / missing input", () => {
    expect(isCommercialKeywordGroup({}).junk).toBe(false);
    expect(isCommercialKeywordGroup({ group_name: "" }).junk).toBe(false);
  });
});

describe("classifyGroup", () => {
  it("aggregates mega-lurker + commercial", () => {
    const r = classifyGroup({
      member_count: 300,
      self_outbound_count: 0,
      group_name: "Big Crypto Giveaway",
    });
    expect(r.junk).toBe(true);
    expect(r.reasons).toContain("mega_lurker");
    expect(r.reasons).toContain("commercial_keyword");
    expect(r.max_confidence).toBe(0.85);
  });

  it("returns clean when no rule hits", () => {
    const r = classifyGroup({
      member_count: 10,
      self_outbound_count: 3,
      sender_counts: { A: 4, B: 3, C: 3 },
      group_name: "Umayr ↔ Sanchay",
    });
    expect(r.junk).toBe(false);
    expect(r.reasons).toEqual([]);
    expect(r.max_confidence).toBe(0);
  });

  it("handles missing ctx", () => {
    const r = classifyGroup();
    expect(r.junk).toBe(false);
  });
});
