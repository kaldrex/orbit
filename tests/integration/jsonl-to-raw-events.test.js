import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonl } from "../../scripts/import-jsonl-to-raw-events.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("readJsonl", () => {
  it("returns valid rows and collects validation errors for invalid ones", async () => {
    const path = resolve(__dirname, "..", "fixtures", "raw-events-sample.jsonl");
    const { valid, invalid } = await readJsonl(path);
    expect(valid).toHaveLength(2);
    expect(invalid).toHaveLength(1);
    expect(invalid[0].error).toMatch(/occurred_at/);
  });
});
