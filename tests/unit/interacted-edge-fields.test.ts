import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..", "..");
const src = readFileSync(resolve(REPO, "src/lib/neo4j.ts"), "utf8");

const REQUIRED_FIELDS = [
  "source_event_id",
  "thread_id",
  "body_preview",
  "direction",
  "source",
];

describe("INTERACTED edge preserves audit fields (regression against aa44a40)", () => {
  for (const field of REQUIRED_FIELDS) {
    it(`Cypher for INTERACTED sets \`${field}\``, () => {
      const idx = src.indexOf("INTERACTED");
      expect(idx, "INTERACTED not found in src/lib/neo4j.ts").toBeGreaterThan(-1);
      const window = src.slice(idx, idx + 2_000);
      const rDotField = new RegExp(`r\\.${field}\\b`);
      const mapKey = new RegExp(`\\b${field}\\s*:`);
      expect(
        rDotField.test(window) || mapKey.test(window),
        `Field \`${field}\` must be written on the INTERACTED edge.`
      ).toBe(true);
    });
  }
});
