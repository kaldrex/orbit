import { describe, it, expect } from "vitest";
import {
  observationSchema,
  observationsBatchSchema,
  MAX_BATCH,
} from "../../src/lib/observations-schema";

const baseEnvelope = {
  observed_at: "2026-04-19T12:00:00Z",
  observer: "wazowski" as const,
  evidence_pointer: "wacli://messages/rowid=12345",
  confidence: 0.9,
  reasoning: "seen in WhatsApp DM thread with Umayr, 40 messages last 30 days",
};

const validInteraction = {
  ...baseEnvelope,
  kind: "interaction" as const,
  payload: {
    participants: ["Sanchay Thalnerkar", "Umayr Sheik"],
    channel: "whatsapp" as const,
    summary: "discussed jewelry AI project scope",
    topic: "tech" as const,
    relationship_context: "close work partner at SinX",
    connection_context: "met through Mumbai ops collaboration",
    sentiment: "positive" as const,
  },
};

const validActivity = {
  ...validInteraction,
  evidence_pointer: "hermes://granola/activity/p1/2026-04-26T18:00:00Z",
  payload: {
    ...validInteraction.payload,
    target_person_id: "00000000-0000-4000-8000-000000000001",
    activity_type: "meeting",
    title: "LocalHost Sponsorship",
    duration_minutes: 45,
    action_items: ["Adjust pricing tiers"],
    outcome: "follow_up_scheduled",
    source: "hermes:granola",
  },
};

const validNote = {
  ...baseEnvelope,
  kind: "note" as const,
  evidence_pointer: "hermes://imessage/note/p1/2026-04-26T15:30:00Z",
  payload: {
    target_person_id: "00000000-0000-4000-8000-000000000001",
    content: "Keith mentioned he is raising in Q3.",
    source: "hermes:imessage",
  },
};

const validPerson = {
  ...baseEnvelope,
  kind: "person" as const,
  evidence_pointer: "wacli://contacts/jid=971586783040@s.whatsapp.net",
  payload: {
    name: "Umayr Sheik",
    company: "SinX",
    category: "team" as const,
    title: "Co-founder",
    relationship_to_me: "Work partner on jewelry AI",
    phones: ["+971586783040"],
    emails: ["usheik@sinxsolutions.ai"],
  },
};

const validCorrection = {
  ...baseEnvelope,
  kind: "correction" as const,
  evidence_pointer: "human://telegram/1776432000",
  confidence: 1,
  payload: {
    target_person_id: "00000000-0000-4000-8000-000000000001",
    field: "company",
    old_value: "Sinx Solutions",
    new_value: "SinX",
    source: "telegram" as const,
  },
};

const validMerge = {
  ...baseEnvelope,
  kind: "merge" as const,
  evidence_pointer: "merge://phone:+971586783040",
  payload: {
    person_id: "00000000-0000-4000-8000-000000000001",
    merged_observation_ids: [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ],
    deterministic_bridges: ["phone:+971586783040"],
  },
};

const validSplit = {
  ...baseEnvelope,
  kind: "split" as const,
  evidence_pointer: "split://person/00000000-0000-4000-8000-000000000001",
  payload: {
    person_id: "00000000-0000-4000-8000-000000000001",
    split_off_observation_ids: ["33333333-3333-4333-8333-333333333333"],
    reason: "founder corrected: different humans, same first name",
  },
};

describe("observationSchema", () => {
  it("accepts a valid interaction observation", () => {
    const parsed = observationSchema.parse(validInteraction);
    expect(parsed.kind).toBe("interaction");
    if (parsed.kind === "interaction") {
      expect(parsed.payload.participants).toHaveLength(2);
    }
  });

  it("accepts Hermes activity metadata on interaction observations", () => {
    const parsed = observationSchema.parse(validActivity);
    if (parsed.kind === "interaction") {
      expect(parsed.payload.target_person_id).toBe(validActivity.payload.target_person_id);
      expect(parsed.payload.activity_type).toBe("meeting");
      expect(parsed.payload.action_items).toEqual(["Adjust pricing tiers"]);
    }
  });

  it("accepts linked note observations", () => {
    const parsed = observationSchema.parse(validNote);
    if (parsed.kind === "note") {
      expect(parsed.payload.content).toContain("raising");
      expect(parsed.payload.source).toBe("hermes:imessage");
    }
  });

  it("accepts a valid person observation with phones and emails", () => {
    const parsed = observationSchema.parse(validPerson);
    if (parsed.kind === "person") {
      expect(parsed.payload.phones).toEqual(["+971586783040"]);
      expect(parsed.payload.emails).toEqual(["usheik@sinxsolutions.ai"]);
    }
  });

  it("accepts valid correction, merge, and split observations", () => {
    expect(() => observationSchema.parse(validCorrection)).not.toThrow();
    expect(() => observationSchema.parse(validMerge)).not.toThrow();
    expect(() => observationSchema.parse(validSplit)).not.toThrow();
  });

  it("rejects unknown kind", () => {
    expect(() =>
      observationSchema.parse({ ...validInteraction, kind: "dream" })
    ).toThrow();
  });

  it("rejects unknown interaction channel", () => {
    const bad = {
      ...validInteraction,
      payload: { ...validInteraction.payload, channel: "tiktok" },
    };
    expect(() => observationSchema.parse(bad)).toThrow();
  });

  it("rejects unknown person category", () => {
    const bad = {
      ...validPerson,
      payload: { ...validPerson.payload, category: "whatsapp_contact" },
    };
    expect(() => observationSchema.parse(bad)).toThrow();
  });

  it("rejects unknown observer", () => {
    expect(() =>
      observationSchema.parse({ ...validInteraction, observer: "not-an-observer" })
    ).toThrow();
  });

  it("rejects confidence outside [0, 1]", () => {
    expect(() =>
      observationSchema.parse({ ...validInteraction, confidence: 1.5 })
    ).toThrow();
    expect(() =>
      observationSchema.parse({ ...validInteraction, confidence: -0.1 })
    ).toThrow();
  });

  it("rejects empty participants in interaction", () => {
    const bad = {
      ...validInteraction,
      payload: { ...validInteraction.payload, participants: [] },
    };
    expect(() => observationSchema.parse(bad)).toThrow();
  });

  it("accepts single-source merge (1 merged_observation_id)", () => {
    // Single-source merges are the manual-entry / single-channel path —
    // see memory/project_single_source_valid.md and the
    // 20260421_single_source_merge migration. A person materialized from
    // one source obs is a valid terminal state.
    const singleSource = {
      ...validMerge,
      payload: {
        ...validMerge.payload,
        merged_observation_ids: ["11111111-1111-4111-8111-111111111111"],
      },
    };
    expect(() => observationSchema.parse(singleSource)).not.toThrow();
  });

  it("rejects merge with zero merged_observation_ids", () => {
    const bad = {
      ...validMerge,
      payload: {
        ...validMerge.payload,
        merged_observation_ids: [] as string[],
      },
    };
    expect(() => observationSchema.parse(bad)).toThrow();
  });

  it("rejects non-UUID person_id in merge", () => {
    const bad = {
      ...validMerge,
      payload: { ...validMerge.payload, person_id: "not-a-uuid" },
    };
    expect(() => observationSchema.parse(bad)).toThrow();
  });

  it("rejects non-ISO-8601 observed_at", () => {
    expect(() =>
      observationSchema.parse({ ...validInteraction, observed_at: "yesterday" })
    ).toThrow();
  });

  it("rejects empty reasoning", () => {
    expect(() =>
      observationSchema.parse({ ...validInteraction, reasoning: "" })
    ).toThrow();
  });

  it("defaults optional person fields (company, title)", () => {
    const minimal = {
      ...baseEnvelope,
      kind: "person" as const,
      evidence_pointer: "wacli://contacts/jid=X",
      payload: {
        name: "Someone",
        category: "friend" as const,
        relationship_to_me: "met once",
      },
    };
    const parsed = observationSchema.parse(minimal);
    if (parsed.kind === "person") {
      expect(parsed.payload.company).toBeNull();
      expect(parsed.payload.title).toBeNull();
      expect(parsed.payload.phones).toEqual([]);
      expect(parsed.payload.emails).toEqual([]);
    }
  });
});

describe("observationsBatchSchema", () => {
  it("accepts a single-element batch", () => {
    expect(() => observationsBatchSchema.parse([validInteraction])).not.toThrow();
  });

  it("rejects empty batch", () => {
    expect(() => observationsBatchSchema.parse([])).toThrow();
  });

  it(`rejects batches larger than MAX_BATCH (${MAX_BATCH})`, () => {
    const big = Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({
      ...validInteraction,
      evidence_pointer: `wacli://messages/rowid=${i}`,
    }));
    expect(() => observationsBatchSchema.parse(big)).toThrow();
  });

  it("accepts a mixed-kind batch", () => {
    expect(() =>
      observationsBatchSchema.parse([
        validInteraction,
        validPerson,
        validCorrection,
        validMerge,
        validSplit,
      ])
    ).not.toThrow();
  });
});
