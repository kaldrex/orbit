import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { wacliToRawEvents } from "../../scripts/import-wacli-to-raw-events.mjs";
import { rawEventsBatchSchema } from "../../src/lib/raw-events-schema";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "..", "fixtures", "wacli-minimal.db");

describe("wacliToRawEvents", () => {
  it("maps all 50 fixture messages to valid raw_events", () => {
    const db = new Database(FIXTURE, { readonly: true });
    const rows = wacliToRawEvents(db, { connectorVersion: "wacli-import-0.1" });
    expect(rows.length).toBe(50);
    for (const r of rows) {
      expect(r.source).toBe("whatsapp");
      expect(typeof r.source_event_id).toBe("string");
      expect(typeof r.thread_id).toBe("string");
      expect(new Date(r.occurred_at).toString()).not.toBe("Invalid Date");
      expect(["in", "out"]).toContain(r.direction);
      expect(r.connector_version).toBe("wacli-import-0.1");
    }
  });

  it("emits rows that pass the shared zod batch schema", () => {
    const db = new Database(FIXTURE, { readonly: true });
    const rows = wacliToRawEvents(db);
    expect(() => rawEventsBatchSchema.parse(rows)).not.toThrow();
  });

  it("source_event_id is compound chat_jid|msg_id for uniqueness across chats", () => {
    const db = new Database(FIXTURE, { readonly: true });
    const rows = wacliToRawEvents(db);
    for (const r of rows) {
      expect(r.source_event_id).toMatch(/^.+\|.+$/);
    }
    const ids = new Set(rows.map((r) => r.source_event_id));
    expect(ids.size).toBe(rows.length);
  });

  it("skips already-seen source_event_ids when a seen set is passed", () => {
    const db = new Database(FIXTURE, { readonly: true });
    const all = wacliToRawEvents(db);
    const seen = new Set(all.slice(0, 10).map((r) => r.source_event_id));
    const remaining = wacliToRawEvents(db, { skipIds: seen });
    expect(remaining).toHaveLength(40);
  });

  it("attaches participant_phones for s.whatsapp.net senders", () => {
    const db = new Database(FIXTURE, { readonly: true });
    const rows = wacliToRawEvents(db);
    const withPhone = rows.filter((r) => r.participant_phones.length > 0);
    expect(withPhone.length).toBeGreaterThan(0);
    for (const r of withPhone) {
      expect(r.participant_phones[0]).toMatch(/^\+\d+$/);
    }
  });

  it("direction maps from from_me (1→out, 0→in)", () => {
    const db = new Database(FIXTURE, { readonly: true });
    const rows = wacliToRawEvents(db);
    const outs = rows.filter((r) => r.direction === "out");
    const ins = rows.filter((r) => r.direction === "in");
    expect(outs.length + ins.length).toBe(rows.length);
    expect(outs.length).toBeGreaterThan(0);
    expect(ins.length).toBeGreaterThan(0);
  });
});
