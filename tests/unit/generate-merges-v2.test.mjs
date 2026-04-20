import { describe, it, expect } from "vitest";

import {
  buildBridgeIndex,
  decideMergeTarget,
  buildMergeObservation,
} from "../../scripts/generate-merges-v2.mjs";

const UMAYR_ID = "67050b91-5011-4ba6-b230-9a387879717a";
const RAMON_ID = "9e7c0448-dd3b-437c-9cda-c512dbc5764b";

const EXISTING = [
  {
    id: UMAYR_ID,
    phones: ["+971586783040"],
    emails: ["usheik@sinxsolutions.ai", "usheik@weddingdai.com", "umayrsheik@gmail.com"],
  },
  {
    id: RAMON_ID,
    phones: ["+17874244135", "+13057974114"],
    emails: ["ramongberrios@gmail.com"],
  },
];

describe("buildBridgeIndex", () => {
  it("indexes both phones and emails", () => {
    const idx = buildBridgeIndex(EXISTING);
    expect(idx.get("phone:+971586783040")).toBe(UMAYR_ID);
    expect(idx.get("email:usheik@sinxsolutions.ai")).toBe(UMAYR_ID);
    expect(idx.get("phone:+17874244135")).toBe(RAMON_ID);
    expect(idx.get("email:ramongberrios@gmail.com")).toBe(RAMON_ID);
  });
  it("lowercases emails", () => {
    const idx = buildBridgeIndex([
      { id: "abc", phones: [], emails: ["UPPER@Example.COM"] },
    ]);
    expect(idx.get("email:upper@example.com")).toBe("abc");
  });
  it("returns empty Map for empty input", () => {
    expect(buildBridgeIndex([]).size).toBe(0);
    expect(buildBridgeIndex(null).size).toBe(0);
  });
});

describe("decideMergeTarget", () => {
  const idx = buildBridgeIndex(EXISTING);

  it("matches Umayr by phone → existing person_id", () => {
    const obs = { payload: { phones: ["+971586783040"], emails: [] } };
    const r = decideMergeTarget(obs, idx);
    expect(r.kind).toBe("existing");
    expect(r.person_id).toBe(UMAYR_ID);
  });

  it("matches Umayr by email → existing person_id", () => {
    const obs = {
      payload: { phones: [], emails: ["usheik@sinxsolutions.ai"] },
    };
    const r = decideMergeTarget(obs, idx);
    expect(r.kind).toBe("existing");
    expect(r.person_id).toBe(UMAYR_ID);
  });

  it("no matching bridges → new UUID", () => {
    const obs = {
      payload: { phones: ["+919999999999"], emails: ["novel@example.test"] },
    };
    const r = decideMergeTarget(obs, idx);
    expect(r.kind).toBe("new");
    expect(r.person_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("two phones, one matches existing → existing wins", () => {
    const obs = {
      payload: {
        phones: ["+971586783040", "+919999999999"],
        emails: [],
      },
    };
    const r = decideMergeTarget(obs, idx);
    expect(r.kind).toBe("existing");
    expect(r.person_id).toBe(UMAYR_ID);
  });

  it("matches TWO existing persons → conflict (not forked)", () => {
    const obs = {
      payload: {
        phones: ["+971586783040"], // Umayr
        emails: ["ramongberrios@gmail.com"], // Ramon
      },
    };
    const r = decideMergeTarget(obs, idx);
    expect(r.kind).toBe("conflict");
    expect(r.person_ids.sort()).toEqual([RAMON_ID, UMAYR_ID].sort());
  });

  it("Umayr-specific regression: stub returns Umayr's id", () => {
    const stubIdx = new Map([["phone:+971586783040", UMAYR_ID]]);
    const obs = { payload: { phones: ["+971586783040"], emails: [] } };
    const r = decideMergeTarget(obs, stubIdx);
    expect(r.person_id).toBe(UMAYR_ID);
  });

  it("empty payload → new UUID (won't crash)", () => {
    const r = decideMergeTarget({ payload: {} }, idx);
    expect(r.kind).toBe("new");
  });
});

describe("buildMergeObservation", () => {
  it("builds the merge envelope with [obsId, obsId] workaround", () => {
    const obs = {
      observed_at: "2026-01-01T00:00:00+00:00",
      payload: { phones: ["+971586783040"], emails: ["u@sinx.ai"] },
    };
    const m = buildMergeObservation({
      obs,
      obsId: "11111111-1111-1111-1111-111111111111",
      personId: UMAYR_ID,
    });
    expect(m.kind).toBe("merge");
    expect(m.payload.person_id).toBe(UMAYR_ID);
    expect(m.payload.deterministic_bridges).toContain("phone:+971586783040");
    expect(m.payload.deterministic_bridges).toContain("email:u@sinx.ai");
    expect(m.payload.merged_observation_ids).toEqual([
      "11111111-1111-1111-1111-111111111111",
      "11111111-1111-1111-1111-111111111111",
    ]);
  });
});
