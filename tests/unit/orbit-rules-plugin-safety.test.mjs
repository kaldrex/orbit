import { describe, it, expect } from "vitest";

import {
  isPhoneAsName,
  isUnicodeMaskedPhone,
  isEmailAsName,
  isQuotedLiteralName,
  isEmptyOrWhitespace,
  isKnownBotName,
  isTestDataLeak,
  safetyDropReason,
} from "../../orbit-rules-plugin/lib/safety.mjs";

describe("isPhoneAsName", () => {
  it("matches +E164", () => {
    expect(isPhoneAsName("+971586783040")).toBe(true);
  });
  it("matches digits-only", () => {
    expect(isPhoneAsName("971586783040")).toBe(true);
  });
  it("matches an Indian +91 number", () => {
    expect(isPhoneAsName("+917208148746")).toBe(true);
  });
  it("does NOT match a real name", () => {
    expect(isPhoneAsName("Umayr Sheik")).toBe(false);
  });
  it("does NOT match a number with spaces (caught by unicode-masked rule instead)", () => {
    // Documented behavior: phone-as-name rule is strict digits; the spaced
    // form '+1 202 555 0199' is caught by isUnicodeMaskedPhone via the
    // whitespace class.
    expect(isPhoneAsName("+1 202 555 0199")).toBe(false);
  });
  it("does NOT match short alpha-numeric", () => {
    expect(isPhoneAsName("1-800 flowers")).toBe(false);
  });
});

describe("isUnicodeMaskedPhone", () => {
  it("matches U+2219 bullet-operator masked", () => {
    expect(isUnicodeMaskedPhone("+91\u2219\u2219\u2219\u2219\u2219\u2219\u2219\u221946")).toBe(true);
  });
  it("matches U+2022 bullet masked", () => {
    expect(isUnicodeMaskedPhone("+91\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u202246")).toBe(true);
  });
  it("matches U+00B7 middle-dot masked", () => {
    expect(isUnicodeMaskedPhone("+91\u00B7\u00B7\u00B7\u00B7\u00B7\u00B7\u00B7\u00B7\u00B746")).toBe(true);
  });
  it("matches U+30FB katakana middle-dot masked", () => {
    expect(isUnicodeMaskedPhone("+91\u30FB\u30FB\u30FB\u30FB\u30FB\u30FB46")).toBe(true);
  });
  it("matches spaced/hyphenated phone", () => {
    expect(isUnicodeMaskedPhone("+1 202 555 0199")).toBe(true);
  });
  it("does NOT match a clean phone number (no mask chars)", () => {
    expect(isUnicodeMaskedPhone("+971586783040")).toBe(false);
  });
  it("does NOT match a real name", () => {
    expect(isUnicodeMaskedPhone("Umayr Sheik")).toBe(false);
  });
  it("does NOT match empty string", () => {
    expect(isUnicodeMaskedPhone("")).toBe(false);
  });
});

describe("isEmailAsName", () => {
  it("matches basic email-as-name", () => {
    expect(isEmailAsName("usheik@sinxsolutions.ai")).toBe(true);
  });
  it("matches another email-as-name", () => {
    expect(isEmailAsName("apitest.lead@example.com")).toBe(true);
  });
  it("matches 'Hari @ Skydo' — documented current behavior as junk", () => {
    // Note: this is a permissive match — "X @ Y" style is treated as junk.
    // We may refine later via email-shape-only detection.
    expect(isEmailAsName("Hari @ Skydo")).toBe(true);
  });
  it("does NOT match a plain name", () => {
    expect(isEmailAsName("Umayr Sheik")).toBe(false);
  });
});

describe("isQuotedLiteralName", () => {
  it("matches single-quoted", () => {
    expect(isQuotedLiteralName("'Sarmista'")).toBe(true);
  });
  it("matches double-quoted", () => {
    expect(isQuotedLiteralName('"Amit"')).toBe(true);
  });
  it("matches curly-quoted", () => {
    expect(isQuotedLiteralName("\u2018Tamas\u2019")).toBe(true);
  });
  it("does NOT match unquoted name", () => {
    expect(isQuotedLiteralName("Umayr")).toBe(false);
  });
  it("does NOT match single char", () => {
    expect(isQuotedLiteralName("'")).toBe(false);
  });
});

describe("isEmptyOrWhitespace", () => {
  it("matches empty string", () => {
    expect(isEmptyOrWhitespace("")).toBe(true);
  });
  it("matches spaces only", () => {
    expect(isEmptyOrWhitespace("   ")).toBe(true);
  });
  it("matches tabs and newlines", () => {
    expect(isEmptyOrWhitespace("\t\n")).toBe(true);
  });
  it("matches null/undefined", () => {
    expect(isEmptyOrWhitespace(null)).toBe(true);
    expect(isEmptyOrWhitespace(undefined)).toBe(true);
  });
  it("does NOT match a name with content", () => {
    expect(isEmptyOrWhitespace("Umayr")).toBe(false);
  });
});

describe("isKnownBotName", () => {
  it("matches wazowski (lowercase)", () => {
    expect(isKnownBotName("wazowski")).toBe(true);
  });
  it("matches Wazowski (mixed case)", () => {
    expect(isKnownBotName("Wazowski")).toBe(true);
  });
  it("matches slackbot", () => {
    expect(isKnownBotName("slackbot")).toBe(true);
  });
  it("does NOT match a human name", () => {
    expect(isKnownBotName("Umayr")).toBe(false);
  });
});

describe("isTestDataLeak", () => {
  it("matches example.com in emails", () => {
    expect(isTestDataLeak("Name", ["apitest.lead@example.com"])).toBe(true);
  });
  it("matches test.com in emails", () => {
    expect(isTestDataLeak("Name", ["john@test.com"])).toBe(true);
  });
  it("matches apitest prefix in name", () => {
    expect(isTestDataLeak("apitest.lead@example.com")).toBe(true);
  });
  it("does NOT match a real phone — phone-test markers are not in this rule", () => {
    expect(isTestDataLeak("Name", [], ["+15555555555"])).toBe(false);
  });
  it("does NOT match a clean record", () => {
    expect(
      isTestDataLeak("Umayr Sheik", ["umayr@sinxsolutions.ai"], ["+971586783040"]),
    ).toBe(false);
  });
});

describe("safetyDropReason", () => {
  it("returns null for a clean candidate", () => {
    expect(
      safetyDropReason({
        name: "Umayr Sheik",
        emails: ["umayr@sinxsolutions.ai"],
        phones: ["+971586783040"],
      }),
    ).toBeNull();
  });
  it("empty beats everything (applied first)", () => {
    // An empty name with a phone-as-name-shaped value in phones[] still
    // returns "empty_name" because the name itself is empty.
    expect(
      safetyDropReason({ name: "", phones: ["+971586783040"] }),
    ).toBe("empty_name");
  });
  it("phone-as-name precedes email-as-name", () => {
    expect(
      safetyDropReason({ name: "+971586783040", emails: ["x@y.com"] }),
    ).toBe("phone_as_name");
  });
  it("unicode-masked phone takes its own code", () => {
    expect(
      safetyDropReason({ name: "+91\u2219\u2219\u2219\u2219\u2219\u2219\u2219\u221946" }),
    ).toBe("unicode_masked_phone");
  });
  it("email-as-name returns email_as_name", () => {
    expect(
      safetyDropReason({ name: "usheik@sinxsolutions.ai" }),
    ).toBe("email_as_name");
  });
  it("quoted literal returns quoted_literal", () => {
    expect(safetyDropReason({ name: "'Sarmista'" })).toBe("quoted_literal");
  });
  it("bot name returns bot_name", () => {
    expect(safetyDropReason({ name: "wazowski" })).toBe("bot_name");
  });
  it("test data leak returns test_data_leak", () => {
    expect(
      safetyDropReason({
        name: "John",
        emails: ["john@test.com"],
      }),
    ).toBe("test_data_leak");
  });
});
