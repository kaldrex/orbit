import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applySeed, bridgeLid } from "../../scripts/lid-bridge-nightly.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SEED = JSON.parse(
  readFileSync(resolve(__dirname, "..", "fixtures", "lid-seed.json"), "utf8"),
);

describe("LID bridge", () => {
  it("applySeed returns exactly 35 mappings from the committed seed", () => {
    const out = applySeed(SEED);
    expect(out.pairs_applied).toBe(35);
    expect(out.rejected).toHaveLength(0);
  });

  it("rejects pairs with confidence < 0.8", () => {
    const bad = { pairs: [{ lid: "x@lid", phone: "+1", confidence: 0.5 }] };
    const out = applySeed(bad);
    expect(out.pairs_applied).toBe(0);
    expect(out.rejected).toHaveLength(1);
  });

  it("single-token overlap yields confidence<1 — never auto-merge (spec §5)", () => {
    const contacts = [
      { jid: "11111111@lid", push_name: "Alice" },
      {
        jid: "911111111111@s.whatsapp.net",
        full_name: "Alice Kumar",
        phone: "+911111111111",
      },
    ];
    const matches = bridgeLid(contacts, { minTokens: 2 });
    expect(matches).toHaveLength(1);
    expect(matches[0].confidence).toBeLessThan(1);
  });
});
