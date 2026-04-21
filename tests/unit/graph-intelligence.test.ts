import { describe, it, expect } from "vitest";
import {
  buildCommunityColorMap,
  communityColorFromId,
  distinctCommunityCount,
  matchByPrefix,
  topHubs,
  type CentralityNode,
  type Community,
  type PersonLite,
} from "@/lib/graph-intelligence";
import { toReagraphNodes, type ApiNode } from "@/lib/graph-transforms";

describe("communityColorFromId", () => {
  it("is deterministic", () => {
    expect(communityColorFromId("c-1")).toBe(communityColorFromId("c-1"));
  });
  it("differs for distinct ids", () => {
    const a = communityColorFromId("c-1");
    const b = communityColorFromId("c-2");
    expect(a).not.toBe(b);
  });
  it("returns an hsl() string", () => {
    expect(communityColorFromId("x")).toMatch(/^hsl\(\d+,\s*\d+%,\s*\d+%\)$/);
  });
});

describe("buildCommunityColorMap", () => {
  const communities: Community[] = [
    { id: 1, size: 3, member_ids: ["a", "b", "c"], top_names: ["A"] },
    { id: 2, size: 2, member_ids: ["d", "e"], top_names: ["D"] },
    // size 1 should be ignored — coloring isolates wouldn't read.
    { id: 3, size: 1, member_ids: ["f"], top_names: ["F"] },
  ];
  it("maps each >=2-member community's members to a shared colour", () => {
    const m = buildCommunityColorMap(communities);
    expect(m.a).toBeDefined();
    expect(m.a).toBe(m.b);
    expect(m.a).toBe(m.c);
    expect(m.d).toBe(m.e);
    expect(m.a).not.toBe(m.d);
  });
  it("does not include singleton members", () => {
    const m = buildCommunityColorMap(communities);
    expect(m.f).toBeUndefined();
  });
});

describe("distinctCommunityCount", () => {
  it("only counts communities with size >= 2", () => {
    expect(
      distinctCommunityCount([
        { id: 1, size: 5, member_ids: [], top_names: [] },
        { id: 2, size: 1, member_ids: [], top_names: [] },
        { id: 3, size: 2, member_ids: [], top_names: [] },
      ]),
    ).toBe(2);
  });
});

describe("topHubs", () => {
  const rows: CentralityNode[] = Array.from({ length: 15 }).map((_, i) => ({
    id: `p${i}`,
    name: `P${i}`,
    category: null,
    betweenness: 100 - i, // p0 = 100 (highest), p14 = 86
    degree: 10,
  }));

  it("returns exactly the top N by betweenness", () => {
    const hubs = topHubs(rows, 10);
    expect(hubs.size).toBe(10);
    expect(hubs.has("p0")).toBe(true);
    expect(hubs.has("p9")).toBe(true);
    expect(hubs.has("p10")).toBe(false);
  });

  it("normalises the top score to 1.0", () => {
    const hubs = topHubs(rows, 10);
    expect(hubs.get("p0")).toBe(1);
    expect(hubs.get("p9")).toBeCloseTo(91 / 100, 5);
  });

  it("handles empty input", () => {
    expect(topHubs([], 10).size).toBe(0);
  });
});

describe("matchByPrefix", () => {
  const corpus: PersonLite[] = [
    { id: "1", name: "Ramon Castro" },
    { id: "2", name: "Rami Okasha" },
    { id: "3", name: "Anjali Ramanathan" },
    { id: "4", name: "Ravi Shankar" },
    { id: "5", name: "Khushal Patel" },
    { id: "6", name: null },
  ];

  it("returns hits when typing 'Ram'", () => {
    const hits = matchByPrefix("Ram", corpus);
    const ids = hits.map((h) => h.id).sort();
    // Matches: Ramon, Rami, Ramanathan (token-prefix), Ravi doesn't start with Ram.
    expect(ids).toContain("1");
    expect(ids).toContain("2");
    expect(ids).toContain("3");
    expect(ids).not.toContain("4");
    expect(ids).not.toContain("5");
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  it("is case-insensitive", () => {
    expect(matchByPrefix("ram", corpus).length).toBeGreaterThan(0);
    expect(matchByPrefix("RAM", corpus).length).toBeGreaterThan(0);
  });

  it("returns nothing for empty query", () => {
    expect(matchByPrefix("   ", corpus)).toEqual([]);
  });

  it("respects the limit", () => {
    const many: PersonLite[] = Array.from({ length: 50 }).map((_, i) => ({
      id: String(i),
      name: `Ramon ${i}`,
    }));
    expect(matchByPrefix("Ramon", many, 5)).toHaveLength(5);
  });

  it("skips persons with null name", () => {
    expect(matchByPrefix("any", corpus).find((p) => p.id === "6")).toBeUndefined();
  });
});

describe("toReagraphNodes overlays", () => {
  const api: ApiNode[] = [
    {
      id: "me",
      name: "Sanchay",
      score: 10,
      category: "self",
      company: null,
      lastInteractionAt: null,
    },
    {
      id: "a",
      name: "Anjali",
      score: 5,
      category: "sponsor",
      company: "Acme",
      lastInteractionAt: null,
    },
    {
      id: "b",
      name: "Bora",
      score: 3,
      category: "friend",
      company: null,
      lastInteractionAt: null,
    },
  ];

  it("annotates top hubs with a hubScore and bumps their size", () => {
    const hubScore = new Map<string, number>([["a", 1], ["b", 0.5]]);
    const baseline = toReagraphNodes(api, "me");
    const withHubs = toReagraphNodes(api, "me", { hubScore });
    const aBase = baseline.find((n) => n.id === "a")!;
    const aHub = withHubs.find((n) => n.id === "a")!;
    expect(aHub.data.hubScore).toBe(1);
    expect(aHub.size).toBeGreaterThan(aBase.size * 1.5 - 0.001); // at least 1.5×
  });

  it("does not annotate non-hub nodes", () => {
    const hubScore = new Map<string, number>([["a", 1]]);
    const withHubs = toReagraphNodes(api, "me", { hubScore });
    const b = withHubs.find((n) => n.id === "b")!;
    expect(b.data.hubScore).toBeUndefined();
  });

  it("overrides fill when communityColor is passed", () => {
    const communityColor = { a: "hsl(10, 60%, 55%)" };
    const nodes = toReagraphNodes(api, "me", { communityColor });
    expect(nodes.find((n) => n.id === "a")!.fill).toBe("hsl(10, 60%, 55%)");
    // Self node fill is always white — community view cannot recolour Sanchay.
    expect(nodes.find((n) => n.id === "me")!.fill).toBe("#FFFFFF");
    // Unassigned node keeps its category colour.
    expect(nodes.find((n) => n.id === "b")!.fill).not.toBe("hsl(10, 60%, 55%)");
  });

  it("top-10 hubs get an annotation, non-top-10 do not", () => {
    // Simulates the end-to-end: /centrality rows → topHubs → toReagraphNodes.
    const rows: CentralityNode[] = Array.from({ length: 15 }).map((_, i) => ({
      id: `n${i}`,
      name: `N${i}`,
      category: null,
      betweenness: 100 - i,
      degree: 5,
    }));
    const hubSet = topHubs(rows, 10);
    const fakeApi: ApiNode[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      score: 5,
      category: "friend",
      company: null,
      lastInteractionAt: null,
    }));
    const nodes = toReagraphNodes(fakeApi, "self-not-present", { hubScore: hubSet });
    const annotated = nodes.filter((n) => n.data.hubScore !== undefined);
    expect(annotated).toHaveLength(10);
    expect(annotated.map((n) => n.id).sort()).toEqual(
      Array.from({ length: 10 }).map((_, i) => `n${i}`).sort(),
    );
  });
});
