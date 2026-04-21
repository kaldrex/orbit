import { describe, it, expect } from "vitest";
import {
  CATEGORY_META,
  FILTER_TO_CATEGORY,
  filterReagraphNodes,
  type ReagraphNode,
} from "@/lib/graph-transforms";

const EXPECTED_CATEGORIES = [
  "self",
  "team",
  "sponsor",
  "fellow",
  "media",
  "community",
  "founder",
  "friend",
  "other",
];

describe("CATEGORY_META", () => {
  it("exposes exactly the 9 reconciled categories", () => {
    expect(Object.keys(CATEGORY_META).sort()).toEqual(
      [...EXPECTED_CATEGORIES].sort(),
    );
  });

  it("every category has a non-empty color + label", () => {
    for (const key of EXPECTED_CATEGORIES) {
      const meta = CATEGORY_META[key];
      expect(meta).toBeDefined();
      expect(meta.color).toMatch(/^#[0-9A-Fa-f]{3,8}$/);
      expect(meta.label.length).toBeGreaterThan(0);
    }
  });

  it("does not include legacy investor/press/gov keys", () => {
    expect(CATEGORY_META.investor).toBeUndefined();
    expect(CATEGORY_META.press).toBeUndefined();
    expect(CATEGORY_META.gov).toBeUndefined();
  });

  it("colors are unique across categories (9-color palette preserved)", () => {
    const colors = Object.values(CATEGORY_META).map((m) => m.color);
    expect(new Set(colors).size).toBe(colors.length);
  });
});

describe("FILTER_TO_CATEGORY", () => {
  it("maps filter pills to canonical categories, no investor/press/gov", () => {
    expect(FILTER_TO_CATEGORY.investors).toBeUndefined();
    expect(FILTER_TO_CATEGORY.press).toBeUndefined();
    expect(FILTER_TO_CATEGORY.gov).toBeUndefined();
    expect(FILTER_TO_CATEGORY.sponsors).toBe("sponsor");
    expect(FILTER_TO_CATEGORY.fellows).toBe("fellow");
    expect(FILTER_TO_CATEGORY.founders).toBe("founder");
    expect(FILTER_TO_CATEGORY.friends).toBe("friend");
  });
});

describe("filterReagraphNodes", () => {
  const nodes: ReagraphNode[] = [
    {
      id: "me",
      label: "Me",
      fill: "#fff",
      size: 22,
      data: { score: 10, category: "self", lastInteractionAt: null, goingCold: false },
    },
    {
      id: "a",
      label: "A",
      fill: "#0f0",
      size: 8,
      data: { score: 7, category: "sponsor", lastInteractionAt: null, goingCold: false },
    },
    {
      id: "b",
      label: "B",
      fill: "#f0f",
      size: 8,
      data: { score: 6, category: "media", lastInteractionAt: null, goingCold: true },
    },
  ];

  it("returns all nodes when filter is 'All'", () => {
    expect(filterReagraphNodes(nodes, "All", "me")).toHaveLength(3);
  });

  it("filters by category (sponsors) + always keeps self node", () => {
    const out = filterReagraphNodes(nodes, "Sponsors", "me");
    const ids = out.map((n) => n.id).sort();
    expect(ids).toEqual(["a", "me"]);
  });

  it("filters by 'Going Cold' + keeps self", () => {
    const out = filterReagraphNodes(nodes, "Going Cold", "me");
    const ids = out.map((n) => n.id).sort();
    expect(ids).toEqual(["b", "me"]);
  });
});
