import { describe, it, expect } from "vitest";
import {
  matchByPrefix,
  type PersonLite,
} from "@/lib/graph-intelligence";

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
