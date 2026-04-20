import { describe, it, expect } from "vitest";

import {
  classifyManifestRow,
  manifestToObservation,
} from "../../scripts/manifest-to-observations.mjs";

function clean(overrides = {}) {
  return {
    id: "local-abc",
    name: "Umayr Sheik",
    phones: ["+971586783040"],
    emails: [],
    groups: [],
    first_seen: "2025-09-19T22:07:50.000Z",
    last_seen: "2025-09-19T22:07:50.000Z",
    thread_count: 3,
    source_provenance: { wa_contact: true, wa_dm: true },
    ...overrides,
  };
}

describe("classifyManifestRow — safety filter", () => {
  it("phone-as-name → SKIPPED (not emitted)", () => {
    const r = classifyManifestRow(clean({ name: "+971586783040" }));
    expect(r.kind).toBe("skip");
    expect(r.reason).toBe("phone_as_name");
  });

  it("clean name → EMIT with payload.name preserved", () => {
    const r = classifyManifestRow(clean({ name: "Umayr Sheik" }));
    expect(r.kind).toBe("emit");
    expect(r.obs.payload.name).toBe("Umayr Sheik");
  });

  it("null name → SKIPPED (no fallback to phone/email)", () => {
    const r = classifyManifestRow(clean({ name: null }));
    expect(r.kind).toBe("skip");
    expect(r.reason).toBe("empty_name");
  });

  it("unicode-masked phone-as-name → SKIPPED with unicode_masked_phone", () => {
    const r = classifyManifestRow(
      clean({ name: "+91\u2219\u2219\u2219\u2219\u2219\u2219\u2219\u221946" }),
    );
    expect(r.kind).toBe("skip");
    expect(r.reason).toBe("unicode_masked_phone");
  });

  it("email-as-name with apitest domain → SKIPPED (either email_as_name or test_data_leak)", () => {
    const r = classifyManifestRow(
      clean({
        name: "apitest.lead@example.com",
        emails: ["apitest.lead@example.com"],
      }),
    );
    expect(r.kind).toBe("skip");
    expect(["email_as_name", "test_data_leak"]).toContain(r.reason);
  });

  it("zero identifiers → SKIPPED with zero_identifiers", () => {
    const r = classifyManifestRow(clean({ phones: [], emails: [] }));
    expect(r.kind).toBe("skip");
    expect(r.reason).toBe("zero_identifiers");
  });
});

describe("manifestToObservation — shape", () => {
  it("observed_at pinned to pre-enrichment seed baseline", () => {
    // Seeds MUST fold before any enriched observation. We pin to a fixed
    // baseline (2026-04-18T00:00:00+00:00) — BEFORE the earliest
    // enrichment — so the card-assembler's latest-wins fold can't
    // clobber enriched fields.
    const o = manifestToObservation(clean());
    expect(o.observed_at).toBe("2026-04-18T00:00:00+00:00");
  });

  it("seed observed_at is independent of manifest last_seen", () => {
    // Even if last_seen is AFTER the enrichment baseline, the seed
    // observation still folds first.
    const o = manifestToObservation(
      clean({ last_seen: "2027-01-01T00:00:00.000Z" }),
    );
    expect(o.observed_at).toBe("2026-04-18T00:00:00+00:00");
  });

  it("relationship_to_me is empty string (NOT placeholder prose)", () => {
    const o = manifestToObservation(clean());
    expect(o.payload.relationship_to_me).toBe("");
    expect(o.payload.relationship_to_me).not.toMatch(/^Appears in/);
  });

  it("category is 'other' by default", () => {
    const o = manifestToObservation(clean());
    expect(o.payload.category).toBe("other");
  });

  it("evidence_pointer uses reingest-20260420:// prefix", () => {
    const o = manifestToObservation(clean());
    expect(o.evidence_pointer).toBe("reingest-20260420://local-abc");
  });

  it("observer is wazowski, kind is person, confidence 0.85", () => {
    const o = manifestToObservation(clean());
    expect(o.observer).toBe("wazowski");
    expect(o.kind).toBe("person");
    expect(o.confidence).toBe(0.85);
  });

  it("phones and emails survive unchanged", () => {
    const o = manifestToObservation(
      clean({ phones: ["+971586783040"], emails: ["u@sinx.ai"] }),
    );
    expect(o.payload.phones).toEqual(["+971586783040"]);
    expect(o.payload.emails).toEqual(["u@sinx.ai"]);
  });

  it("name truncates at 256 chars", () => {
    const long = "x".repeat(400);
    const o = manifestToObservation(clean({ name: long }));
    expect(o.payload.name.length).toBe(256);
  });
});

describe("classifyManifestRow — batch properties", () => {
  it("mixed 10-row input sums correctly", () => {
    const rows = [
      clean({ name: "Umayr Sheik" }),          // emit
      clean({ name: "Ramon Berrios" }),        // emit
      clean({ name: "+971586783040" }),        // skip phone
      clean({ name: "apitest@example.com" }),  // skip test-leak
      clean({ name: "" }),                     // skip empty
      clean({ name: "'Sarmista'" }),           // skip quoted
      clean({ name: "wazowski" }),             // skip bot
      clean({ name: "Eve Thakur" }),           // emit
      clean({ name: null, phones: [], emails: [] }), // skip zero-id
      clean({ name: "+91\u2219\u2219\u2219\u2219\u2219\u221946" }), // skip unicode-mask
    ];
    let emit = 0;
    let skip = 0;
    for (const r of rows) {
      const out = classifyManifestRow(r);
      if (out.kind === "emit") emit += 1;
      else skip += 1;
    }
    expect(emit).toBe(3);
    expect(skip).toBe(7);
    expect(emit + skip).toBe(rows.length);
  });
});
