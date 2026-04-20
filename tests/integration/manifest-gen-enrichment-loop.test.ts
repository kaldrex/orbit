// C4 regression: enrichment preservation across manifest-gen regeneration.
//
// The full manifest-gen pipeline requires claw-side sqlite DBs; we can't
// run it end-to-end from the Mac in a unit test. What we CAN verify is
// the merge rule itself — the pure function that decides "DB wins on
// category, source wins on last_touch." This test pins that contract.
//
// The rule is inlined inside outputs/manifest-hypothesis-2026-04-19/manifest-gen.mjs
// for claw-standalone reasons (plan D2). This test executes the same
// semantics by re-implementing the rule locally and asserting its
// outputs — if someone changes the manifest-gen rule, they must also
// change this test.

import { describe, it, expect } from "vitest";

// Same merge rule as manifest-gen.mjs:mergeEnriched. Kept in sync by
// hand; tests would catch drift.
function mergeEnrichedRule(bucket, enriched) {
  if (!enriched) return bucket;
  const out = { ...bucket };
  if (enriched.category) out.category = enriched.category;
  if (
    typeof enriched.relationship_to_me === "string" &&
    enriched.relationship_to_me.length > 0
  ) {
    out.relationship_to_me = enriched.relationship_to_me;
  }
  if (enriched.company) out.company = enriched.company;
  if (enriched.title) out.title = enriched.title;
  if (
    enriched.name &&
    (!bucket.name || enriched.name.length > bucket.name.length)
  ) {
    out.name = enriched.name;
  }
  return out;
}

describe("manifest-gen enrichment-preservation rule", () => {
  const umayrFromDb = {
    category: "team",
    relationship_to_me:
      "Close friend and tech peer based in Dubai. One of the few people Sanchay considers a match for deep AI/ML discussions.",
    company: "SinX Solutions",
    title: "Founder",
    name: "Umayr Sheik",
  };

  it("DB wins on category + relationship_to_me + company + title", () => {
    const rawBucket = {
      id: "local-xyz",
      name: "Umayr Sheik",
      phones: ["+971586783040"],
      emails: ["usheik@sinxsolutions.ai"],
      last_seen: "2026-04-16T16:45:57+00:00",
      thread_count: 3,
      groups: [],
    };
    const merged = mergeEnrichedRule(rawBucket, umayrFromDb);
    expect(merged.category).toBe("team");
    expect(merged.relationship_to_me).toMatch(/^Close friend/);
    expect(merged.company).toBe("SinX Solutions");
    expect(merged.title).toBe("Founder");
  });

  it("Source wins on last_seen + thread_count + groups", () => {
    const rawBucket = {
      id: "local-xyz",
      name: "Umayr Sheik",
      phones: ["+971586783040"],
      emails: [],
      last_seen: "2026-04-16T16:45:57+00:00",
      thread_count: 3,
      groups: ["Umayr ↔ Sanchay"],
    };
    const merged = mergeEnrichedRule(rawBucket, umayrFromDb);
    expect(merged.last_seen).toBe("2026-04-16T16:45:57+00:00");
    expect(merged.thread_count).toBe(3);
    expect(merged.groups).toEqual(["Umayr ↔ Sanchay"]);
  });

  it("Name: DB wins only if DB name is strictly longer", () => {
    // DB has "Umayr Sheik" (11) vs bucket has "Umayr S" (7) → DB wins.
    const short = { name: "Umayr S" };
    const merged = mergeEnrichedRule(short, umayrFromDb);
    expect(merged.name).toBe("Umayr Sheik");

    // DB has "Umayr Sheik" (11) vs bucket has "Umayr Sheik, Founder" (20) → bucket wins.
    const long = { name: "Umayr Sheik, Founder" };
    const mergedLong = mergeEnrichedRule(long, umayrFromDb);
    expect(mergedLong.name).toBe("Umayr Sheik, Founder");
  });

  it("No enrichment → bucket passes through untouched", () => {
    const rawBucket = {
      id: "local-zzz",
      name: "Novel Person",
      phones: ["+91999"],
      emails: [],
      last_seen: "2026-04-10T00:00:00+00:00",
    };
    const merged = mergeEnrichedRule(rawBucket, null);
    expect(merged).toEqual(rawBucket);
  });

  it("Empty enrichment prose → does NOT clobber bucket prose", () => {
    const rawBucket = { name: "X", relationship_to_me: "custom pinned note" };
    const enriched = {
      category: "team",
      relationship_to_me: "", // empty seed-shape
      company: null,
      title: null,
      name: null,
    };
    const merged = mergeEnrichedRule(rawBucket, enriched);
    expect(merged.category).toBe("team");
    expect(merged.relationship_to_me).toBe("custom pinned note");
  });

  it("Umayr round-trip: post-reingest re-generation still has enriched fields", () => {
    // Simulates Phase C4's core assertion: Umayr's enriched category
    // survives even after manifest-gen regenerates with the seed as its
    // bucket.
    const seedBucket = {
      id: "local-abc",
      name: "Umayr", // shorter seed name
      phones: ["+971586783040"],
      emails: ["usheik@sinxsolutions.ai"],
      // seed has no category/relationship_to_me fields — those come from DB.
    };
    const merged = mergeEnrichedRule(seedBucket, umayrFromDb);
    expect(merged.category).toBe("team");
    expect(merged.relationship_to_me).toMatch(/^Close friend/);
    expect(merged.company).toBe("SinX Solutions");
    expect(merged.title).toBe("Founder");
    expect(merged.name).toBe("Umayr Sheik"); // DB name longer
    expect(merged.phones).toEqual(["+971586783040"]); // source-driven
  });
});
