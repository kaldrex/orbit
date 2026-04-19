import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { normalizePhone } from "../../orbit-rules-plugin/lib/phone.mjs";
import { canonicalizeEmail } from "../../orbit-rules-plugin/lib/email.mjs";
import { domainClass } from "../../orbit-rules-plugin/lib/domain.mjs";
import { lidToPhone } from "../../orbit-rules-plugin/lib/lid.mjs";
import { fuzzyMatch } from "../../orbit-rules-plugin/lib/fuzzy.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DB = path.join(here, "..", "fixtures", "session-minimal.db");

describe("normalizePhone", () => {
  it("parses a WhatsApp jid to E.164", () => {
    const r = normalizePhone({ phone: "971586783040@s.whatsapp.net" });
    expect(r.valid).toBe(true);
    expect(r.e164).toBe("+971586783040");
    expect(r.country_code).toBe("AE");
  });

  it("parses a formatted international string", () => {
    const r = normalizePhone({ phone: "+971 58 678 3040" });
    expect(r.valid).toBe(true);
    expect(r.e164).toBe("+971586783040");
  });

  it("parses an Indian local number with default_country IN", () => {
    const r = normalizePhone({ phone: "9136820958", default_country: "IN" });
    expect(r.valid).toBe(true);
    expect(r.e164).toBe("+919136820958");
    expect(r.country_code).toBe("IN");
  });

  it("returns invalid for garbage input", () => {
    const r = normalizePhone({ phone: "not-a-phone" });
    expect(r.valid).toBe(false);
    expect(r.e164).toBeNull();
  });

  it("returns invalid for empty input", () => {
    const r = normalizePhone({ phone: "" });
    expect(r.valid).toBe(false);
  });

  it("strips lid and g.us suffixes before parsing", () => {
    const lidLike = normalizePhone({ phone: "207283862659127@lid" });
    // 207... isn't a real phone, should fail
    expect(lidLike.valid).toBe(false);
  });
});

describe("canonicalizeEmail", () => {
  it("lowercases and strips +suffix on gmail", () => {
    const r = canonicalizeEmail({ email: "Sanchay.Dev+newsletter@Gmail.com" });
    expect(r.valid).toBe(true);
    expect(r.canonical).toBe("sanchaydev@gmail.com");
    expect(r.domain).toBe("gmail.com");
  });

  it("collapses googlemail.com to gmail.com", () => {
    const r = canonicalizeEmail({ email: "me@googlemail.com" });
    expect(r.canonical).toBe("me@gmail.com");
    expect(r.domain).toBe("gmail.com");
  });

  it("keeps dots for non-gmail domains", () => {
    const r = canonicalizeEmail({ email: "First.Last@company.com" });
    expect(r.canonical).toBe("first.last@company.com");
    expect(r.domain).toBe("company.com");
  });

  it("strips +suffix on non-gmail too", () => {
    const r = canonicalizeEmail({ email: "user+tag@company.com" });
    expect(r.canonical).toBe("user@company.com");
  });

  it("returns invalid for malformed input", () => {
    const r = canonicalizeEmail({ email: "not-an-email" });
    expect(r.valid).toBe(false);
    expect(r.canonical).toBeNull();
  });

  it("returns invalid for empty input", () => {
    const r = canonicalizeEmail({ email: "" });
    expect(r.valid).toBe(false);
  });
});

describe("domainClass", () => {
  it("classifies gmail.com as personal", () => {
    const r = domainClass({ domain: "gmail.com" });
    expect(r.class).toBe("personal");
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  it("classifies notion.so as saas", () => {
    const r = domainClass({ domain: "notion.so" });
    expect(r.class).toBe("saas");
  });

  it("classifies nytimes.com as press", () => {
    const r = domainClass({ domain: "nytimes.com" });
    expect(r.class).toBe("press");
  });

  it("classifies a random corporate domain as work (default)", () => {
    const r = domainClass({ domain: "sinxsolutions.ai" });
    expect(r.class).toBe("work");
  });

  it("detects bot via local-part even when domain is unknown", () => {
    const r = domainClass({
      domain: "example.com",
      localpart_for_bot_check: "noreply",
    });
    expect(r.class).toBe("bot");
  });

  it("returns other for empty input", () => {
    const r = domainClass({ domain: "" });
    expect(r.class).toBe("other");
  });
});

describe("lidToPhone (fixture)", () => {
  it("resolves a known LID to E.164", () => {
    const r = lidToPhone({
      lid: "207283862659127",
      db_path_override: FIXTURE_DB,
    });
    expect(r.phone).toBe("+971586783040");
  });

  it("strips @lid suffix before lookup", () => {
    const r = lidToPhone({
      lid: "207283862659127@lid",
      db_path_override: FIXTURE_DB,
    });
    expect(r.phone).toBe("+971586783040");
  });

  it("returns null phone for unknown LID", () => {
    const r = lidToPhone({
      lid: "999999999999999",
      db_path_override: FIXTURE_DB,
    });
    expect(r.phone).toBeNull();
  });

  it("returns null phone for empty input", () => {
    const r = lidToPhone({ lid: "", db_path_override: FIXTURE_DB });
    expect(r.phone).toBeNull();
  });
});

describe("fuzzyMatch", () => {
  it("scores identical names as 1", () => {
    const r = fuzzyMatch({ name_a: "Umayr Sheik", name_b: "Umayr Sheik" });
    expect(r.score).toBe(1);
  });

  it("scores Umayr vs Umayr Sheik high (token-set)", () => {
    const r = fuzzyMatch({ name_a: "Umayr", name_b: "Umayr Sheik" });
    expect(r.score).toBeGreaterThan(0.85);
  });

  it("scores Umayr vs Umaye high (JW typo)", () => {
    const r = fuzzyMatch({ name_a: "Umayr", name_b: "Umaye" });
    expect(r.score).toBeGreaterThan(0.8);
  });

  it("scores totally different names low", () => {
    const r = fuzzyMatch({ name_a: "Umayr", name_b: "Ramon Berrios" });
    expect(r.score).toBeLessThan(0.6);
  });

  it("handles diacritics and case", () => {
    const r = fuzzyMatch({ name_a: "José García", name_b: "jose garcia" });
    expect(r.score).toBe(1);
  });

  it("returns 0 for empty inputs", () => {
    const r = fuzzyMatch({ name_a: "", name_b: "Umayr" });
    expect(r.score).toBe(0);
  });
});
