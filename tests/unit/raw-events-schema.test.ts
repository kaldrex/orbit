import { describe, it, expect } from "vitest";
import { rawEventSchema, rawEventsBatchSchema } from "../../src/lib/raw-events-schema";

const validEvent = {
  source: "whatsapp" as const,
  source_event_id: "wa_msg_0001",
  channel: "whatsapp",
  occurred_at: "2026-04-18T12:00:00Z",
  direction: "in" as const,
  thread_id: "chat_jid_abc",
  participants_raw: [{ jid: "911111111111@s.whatsapp.net" }],
  participant_phones: ["+911111111111"],
  participant_emails: [],
  body_preview: "hi",
  attachments_present: false,
  connector_version: "0.4.2",
  raw_ref: null,
};

describe("rawEventSchema", () => {
  it("accepts a valid event", () => {
    expect(rawEventSchema.parse(validEvent)).toMatchObject({
      source: validEvent.source,
      source_event_id: validEvent.source_event_id,
    });
  });

  it("rejects unknown source", () => {
    expect(() =>
      rawEventSchema.parse({ ...validEvent, source: "tiktok" })
    ).toThrow();
  });

  it("rejects missing source_event_id", () => {
    const bad = { ...validEvent } as Record<string, unknown>;
    delete bad.source_event_id;
    expect(() => rawEventSchema.parse(bad)).toThrow();
  });

  it("rejects direction outside {in,out}", () => {
    expect(() =>
      rawEventSchema.parse({ ...validEvent, direction: "sideways" })
    ).toThrow();
  });

  it("defaults arrays and attachments_present", () => {
    const minimal = {
      source: "gmail" as const,
      source_event_id: "gmail_abc",
      channel: "gmail",
      occurred_at: "2026-04-18T12:00:00Z",
    };
    const parsed = rawEventSchema.parse(minimal);
    expect(parsed.participants_raw).toEqual([]);
    expect(parsed.participant_phones).toEqual([]);
    expect(parsed.participant_emails).toEqual([]);
    expect(parsed.attachments_present).toBe(false);
  });

  it("truncates body_preview to 160 chars", () => {
    const long = "x".repeat(400);
    const parsed = rawEventSchema.parse({ ...validEvent, body_preview: long });
    expect(parsed.body_preview).toHaveLength(160);
  });

  it("batch rejects >500 rows", () => {
    const big = Array.from({ length: 501 }, (_, i) => ({
      ...validEvent,
      source_event_id: `wa_${i}`,
    }));
    expect(() => rawEventsBatchSchema.parse(big)).toThrow();
  });

  it("batch rejects 0 rows", () => {
    expect(() => rawEventsBatchSchema.parse([])).toThrow();
  });
});
