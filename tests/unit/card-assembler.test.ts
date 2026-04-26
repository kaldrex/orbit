import { describe, it, expect } from "vitest";
import { assembleCard, type ObservationRow } from "../../src/lib/card-assembler";

const personId = "00000000-0000-4000-8000-000000000001";

function obs(
  overrides: Partial<ObservationRow> & { kind: ObservationRow["kind"] },
): ObservationRow {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    user_id: "u1",
    observed_at: overrides.observed_at ?? "2026-04-01T00:00:00Z",
    ingested_at: "2026-04-19T00:00:00Z",
    observer: "wazowski",
    evidence_pointer: overrides.evidence_pointer ?? "test://default",
    confidence: overrides.confidence ?? 0.9,
    reasoning: overrides.reasoning ?? "test",
    payload: overrides.payload ?? {},
    kind: overrides.kind,
  };
}

describe("assembleCard", () => {
  it("returns an empty card for zero observations", () => {
    const card = assembleCard(personId, []);
    expect(card.person_id).toBe(personId);
    expect(card.name).toBeNull();
    expect(card.phones).toEqual([]);
    expect(card.emails).toEqual([]);
    expect(card.last_touch).toBeNull();
    expect(card.observations.total).toBe(0);
  });

  it("folds latest-wins across multiple person observations", () => {
    const rows: ObservationRow[] = [
      obs({
        kind: "person",
        observed_at: "2026-04-01T00:00:00Z",
        payload: {
          name: "Umayr",
          company: null,
          category: "team",
          title: null,
          relationship_to_me: "saw once",
          phones: ["+971586783040"],
          emails: [],
        },
      }),
      obs({
        kind: "person",
        observed_at: "2026-04-10T00:00:00Z",
        payload: {
          name: "Umayr Sheik",
          company: "Sinx Solutions",
          category: "team",
          title: "Co-founder",
          relationship_to_me: "work partner at SinX, jewelry AI",
          phones: ["+971586783040"],
          emails: ["usheik@sinxsolutions.ai"],
        },
      }),
    ];
    const card = assembleCard(personId, rows);
    expect(card.name).toBe("Umayr Sheik"); // later observation wins
    expect(card.company).toBe("Sinx Solutions");
    expect(card.title).toBe("Co-founder");
    expect(card.relationship_to_me).toContain("jewelry");
    expect(card.phones).toEqual(["+971586783040"]);
    expect(card.emails).toEqual(["usheik@sinxsolutions.ai"]);
  });

  it("unions phones and emails across observations", () => {
    const rows: ObservationRow[] = [
      obs({
        kind: "person",
        observed_at: "2026-04-01T00:00:00Z",
        payload: {
          name: "Umayr",
          category: "team",
          phones: ["+971586783040"],
          emails: [],
        },
      }),
      obs({
        kind: "person",
        observed_at: "2026-04-10T00:00:00Z",
        payload: {
          name: "Umayr",
          category: "team",
          phones: ["+971500000000"],
          emails: ["usheik@sinx.ai"],
        },
      }),
    ];
    const card = assembleCard(personId, rows);
    expect(card.phones.sort()).toEqual(["+971500000000", "+971586783040"].sort());
    expect(card.emails).toEqual(["usheik@sinx.ai"]);
  });

  it("applies corrections as ground truth over folded fields", () => {
    const rows: ObservationRow[] = [
      obs({
        kind: "person",
        observed_at: "2026-04-01T00:00:00Z",
        payload: {
          name: "Umayr",
          company: "Sinx Solutions",
          category: "team",
          relationship_to_me: "saw in group",
        },
      }),
      obs({
        kind: "correction",
        observed_at: "2026-04-19T00:00:00Z",
        confidence: 1,
        payload: {
          target_person_id: personId,
          field: "company",
          old_value: "Sinx Solutions",
          new_value: "SinX",
          source: "telegram",
        },
      }),
    ];
    const card = assembleCard(personId, rows);
    expect(card.company).toBe("SinX");
    expect(card.observations.recent_corrections).toHaveLength(1);
  });

  it("folds relationship_strength corrections", () => {
    const rows: ObservationRow[] = [
      obs({
        kind: "correction",
        observed_at: "2026-04-19T00:00:00Z",
        payload: {
          target_person_id: personId,
          field: "relationship_strength",
          old_value: null,
          new_value: "warm",
          source: "other",
        },
      }),
    ];
    const card = assembleCard(personId, rows);
    expect(card.relationship_strength).toBe("warm");
  });

  it("collects recent notes without changing last_touch", () => {
    const rows: ObservationRow[] = [
      obs({
        kind: "interaction",
        observed_at: "2026-04-12T00:00:00Z",
        payload: {
          participants: ["Sanchay", "Umayr"],
          channel: "meeting",
          summary: "meeting",
          topic: "business",
          relationship_context: "",
          connection_context: "",
          sentiment: "neutral",
        },
      }),
      obs({
        kind: "note",
        observed_at: "2026-04-20T00:00:00Z",
        payload: {
          target_person_id: personId,
          content: "raising in Q3",
          source: "hermes:imessage",
        },
      }),
    ];
    const card = assembleCard(personId, rows);
    expect(card.last_touch).toBe("2026-04-12T00:00:00Z");
    expect(card.observations.recent_notes).toHaveLength(1);
    expect(card.observations.recent_notes[0].summary).toBe("raising in Q3");
  });

  it("correction with null new_value clears an optional field", () => {
    const rows: ObservationRow[] = [
      obs({
        kind: "person",
        observed_at: "2026-04-01T00:00:00Z",
        payload: {
          name: "Umayr",
          company: "SinX",
          title: "Co-founder",
          category: "team",
        },
      }),
      obs({
        kind: "correction",
        observed_at: "2026-04-19T00:00:00Z",
        payload: {
          target_person_id: personId,
          field: "title",
          old_value: "Co-founder",
          new_value: null,
          source: "telegram",
        },
      }),
    ];
    const card = assembleCard(personId, rows);
    expect(card.title).toBeNull();
  });

  it("correction on phones replaces the set (doesn't union)", () => {
    const rows: ObservationRow[] = [
      obs({
        kind: "person",
        observed_at: "2026-04-01T00:00:00Z",
        payload: {
          name: "Umayr",
          category: "team",
          phones: ["+971586783040", "+971500000000"],
        },
      }),
      obs({
        kind: "correction",
        observed_at: "2026-04-19T00:00:00Z",
        payload: {
          target_person_id: personId,
          field: "phones",
          old_value: null,
          new_value: ["+971586783040"],
          source: "telegram",
        },
      }),
    ];
    const card = assembleCard(personId, rows);
    expect(card.phones).toEqual(["+971586783040"]);
  });

  it("last_touch is max observed_at across interactions", () => {
    const rows: ObservationRow[] = [
      obs({
        kind: "interaction",
        observed_at: "2026-04-01T00:00:00Z",
        payload: {
          participants: ["Sanchay", "Umayr"],
          channel: "whatsapp",
          summary: "older msg",
          topic: "tech",
          relationship_context: "",
          connection_context: "",
          sentiment: "neutral",
        },
      }),
      obs({
        kind: "interaction",
        observed_at: "2026-04-12T00:00:00Z",
        payload: {
          participants: ["Sanchay", "Umayr"],
          channel: "whatsapp",
          summary: "newer msg",
          topic: "tech",
          relationship_context: "",
          connection_context: "",
          sentiment: "positive",
        },
      }),
    ];
    const card = assembleCard(personId, rows);
    expect(card.last_touch).toBe("2026-04-12T00:00:00Z");
  });

  it("caps interactions at 20 most recent and corrections at 10", () => {
    const rows: ObservationRow[] = [];
    for (let i = 0; i < 30; i++) {
      rows.push(
        obs({
          kind: "interaction",
          observed_at: `2026-04-${String((i % 30) + 1).padStart(2, "0")}T00:00:00Z`,
          payload: {
            participants: ["S", "U"],
            channel: "whatsapp",
            summary: `msg ${i}`,
            topic: "tech",
            relationship_context: "",
            connection_context: "",
            sentiment: "neutral",
          },
        }),
      );
    }
    for (let i = 0; i < 15; i++) {
      rows.push(
        obs({
          kind: "correction",
          observed_at: `2026-04-${String((i % 30) + 1).padStart(2, "0")}T12:00:00Z`,
          payload: {
            target_person_id: personId,
            field: "name",
            old_value: null,
            new_value: `v${i}`,
            source: "telegram",
          },
        }),
      );
    }
    const card = assembleCard(personId, rows);
    expect(card.observations.interactions.length).toBe(20);
    expect(card.observations.recent_corrections.length).toBe(10);
    expect(card.observations.total).toBe(45);
  });

  // Phase 2: the assembler prefers a pass_kind='summary' snapshot over the
  // observation-derived headline. Other fields (name/category/etc.) still
  // come from observations — snapshots only override one_paragraph_summary.
  it("uses summarySnapshot for one_paragraph_summary when provided", () => {
    const rows: ObservationRow[] = [
      obs({
        kind: "person",
        observed_at: "2026-04-10T00:00:00Z",
        payload: {
          name: "Poojan Vig",
          category: "friend",
          title: null,
          relationship_to_me: "long-time friend",
          phones: [],
          emails: [],
        },
      }),
      obs({
        kind: "interaction",
        observed_at: "2026-04-18T00:00:00Z",
        payload: {
          participants: ["Sanchay", "Poojan"],
          channel: "whatsapp",
          summary: "chatted about weekend plans",
          topic: "personal",
          relationship_context: "",
          connection_context: "",
          sentiment: "positive",
        },
      }),
    ];

    const summarySnapshot = {
      id: "22222222-2222-4222-8222-222222222222",
      person_id: personId,
      pass_at: "2026-04-21T00:00:00Z",
      pass_kind: "summary" as const,
      card_state: { relationship_to_me: "your co-lead at Acme" },
      evidence_pointer_ids: [],
      diff_summary: "Conviction shifted: from friend → co-lead (weekly 1:1s)",
      confidence_delta: {},
      created_at: "2026-04-21T00:00:00Z",
    };

    const card = assembleCard(personId, rows, summarySnapshot);
    // Headline is now the snapshot's — NOT the observation-derived fold.
    expect(card.one_paragraph_summary).toContain("co-lead at Acme");
    expect(card.one_paragraph_summary).toContain("weekly 1:1s");
    // But the fold-level fields are still observation-derived.
    expect(card.name).toBe("Poojan Vig");
    expect(card.category).toBe("friend");
    expect(card.relationship_to_me).toBe("long-time friend");
  });

  it("falls back to observation-derived summary when no snapshot provided", () => {
    const rows: ObservationRow[] = [
      obs({
        kind: "person",
        observed_at: "2026-04-10T00:00:00Z",
        payload: {
          name: "Poojan Vig",
          category: "friend",
          relationship_to_me: "long-time friend",
          phones: [],
          emails: [],
        },
      }),
    ];
    const card = assembleCard(personId, rows);
    expect(card.one_paragraph_summary).toBe("long-time friend");
  });

  it("falls back to observation-derived summary when summarySnapshot is null", () => {
    const rows: ObservationRow[] = [
      obs({
        kind: "person",
        observed_at: "2026-04-10T00:00:00Z",
        payload: {
          name: "Poojan Vig",
          category: "friend",
          relationship_to_me: "long-time friend",
          phones: [],
          emails: [],
        },
      }),
    ];
    const card = assembleCard(personId, rows, null);
    expect(card.one_paragraph_summary).toBe("long-time friend");
  });
});
