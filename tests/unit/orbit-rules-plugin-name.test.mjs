import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  pickBestName,
  collectMessageSenderNames,
} from "../../orbit-rules-plugin/lib/name.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DB = path.join(here, "..", "fixtures", "wacli-minimal.db");

describe("pickBestName", () => {
  it("priority: wa_contact beats wa_group_sender", () => {
    expect(
      pickBestName([
        { source: "wa_group_sender", name: "U" },
        { source: "wa_contact", name: "Umayr Sheik" },
      ]),
    ).toBe("Umayr Sheik");
  });

  it("safety filter drops phone-as-name even at high priority", () => {
    expect(
      pickBestName([
        { source: "wa_contact", name: "+971586783040" },
      ]),
    ).toBeNull();
  });

  it("tie on priority: longer string wins", () => {
    expect(
      pickBestName([
        { source: "wa_contact", name: "Umayr" },
        { source: "wa_contact", name: "Umayr Sheik" },
      ]),
    ).toBe("Umayr Sheik");
  });

  it("returns null when all candidates fail safety", () => {
    expect(
      pickBestName([
        { source: "wa_contact", name: "+971586783040" },
        { source: "gmail_from", name: "apitest.lead@example.com" },
      ]),
    ).toBeNull();
  });

  it("wa_message_sender sits between wa_group_sender and unknown", () => {
    // wa_group_sender (60) beats wa_message_sender (55)
    expect(
      pickBestName([
        { source: "wa_message_sender", name: "U From Push" },
        { source: "wa_group_sender", name: "U From Group" },
      ]),
    ).toBe("U From Group");
    // wa_message_sender (55) beats unknown (0)
    expect(
      pickBestName([
        { source: "unknown", name: "Fallback" },
        { source: "wa_message_sender", name: "U From Push" },
      ]),
    ).toBe("U From Push");
  });

  it("returns null for empty input", () => {
    expect(pickBestName([])).toBeNull();
    expect(pickBestName(null)).toBeNull();
    expect(pickBestName(undefined)).toBeNull();
  });
});

describe("collectMessageSenderNames", () => {
  it("reads sender_name from wacli messages, grouped by count desc", () => {
    const db = new Database(FIXTURE_DB, { readonly: true });
    try {
      // The fixture seeds DM chat 911111111111 with 5 messages alternating
      // from_me; the inbound ones carry sender_name="Alice Kumar".
      const rows = collectMessageSenderNames(
        db,
        "911111111111@s.whatsapp.net",
      );
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
      // Every row has {name, count, ts_max}
      for (const r of rows) {
        expect(typeof r.name).toBe("string");
        expect(r.name.length).toBeGreaterThan(0);
        expect(typeof r.count).toBe("number");
        expect(typeof r.ts_max).toBe("number");
      }
      // Counts monotonic-descending
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i - 1].count).toBeGreaterThanOrEqual(rows[i].count);
      }
    } finally {
      db.close();
    }
  });

  it("returns [] for unknown jid", () => {
    const db = new Database(FIXTURE_DB, { readonly: true });
    try {
      expect(
        collectMessageSenderNames(db, "999999999999@s.whatsapp.net"),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("returns [] for bad inputs", () => {
    expect(collectMessageSenderNames(null, "x")).toEqual([]);
    const db = new Database(FIXTURE_DB, { readonly: true });
    try {
      expect(collectMessageSenderNames(db, "")).toEqual([]);
    } finally {
      db.close();
    }
  });
});
