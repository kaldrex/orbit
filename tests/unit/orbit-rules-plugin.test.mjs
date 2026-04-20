import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { normalizePhone } from "../../orbit-rules-plugin/lib/phone.mjs";
import { canonicalizeEmail } from "../../orbit-rules-plugin/lib/email.mjs";
import { domainClass } from "../../orbit-rules-plugin/lib/domain.mjs";
import {
  lidToPhone,
  phoneForContact,
  isResolvableLidContact,
  bareLid,
} from "../../orbit-rules-plugin/lib/lid.mjs";
import { fuzzyMatch } from "../../orbit-rules-plugin/lib/fuzzy.mjs";
import { stripForwardedChainName } from "../../orbit-rules-plugin/lib/forwarded.mjs";
import {
  decideCrossChannelMerge,
  crossChannelBridge,
} from "../../orbit-rules-plugin/lib/bridge.mjs";

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

  // Fix #1: extended bot-localpart patterns
  it("classifies account-info@skydo.com as bot", () => {
    const r = domainClass({
      domain: "skydo.com",
      localpart_for_bot_check: "account-info",
    });
    expect(r.class).toBe("bot");
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("classifies receipts@foo.com as bot", () => {
    const r = domainClass({
      domain: "foo.com",
      localpart_for_bot_check: "receipts",
    });
    expect(r.class).toBe("bot");
  });

  it("classifies billing-info@vendor.com as bot", () => {
    const r = domainClass({
      domain: "vendor.com",
      localpart_for_bot_check: "billing-info",
    });
    expect(r.class).toBe("bot");
  });

  it("classifies statements@bank.com as bot", () => {
    const r = domainClass({
      domain: "bank.com",
      localpart_for_bot_check: "statements",
    });
    expect(r.class).toBe("bot");
  });

  it("classifies mailer@foo.com as bot", () => {
    const r = domainClass({
      domain: "foo.com",
      localpart_for_bot_check: "mailer",
    });
    expect(r.class).toBe("bot");
  });

  it("classifies notify@app.com as bot", () => {
    const r = domainClass({
      domain: "app.com",
      localpart_for_bot_check: "notify",
    });
    expect(r.class).toBe("bot");
  });

  it("classifies notifications.stripe.com-style subdomain as bot", () => {
    const r = domainClass({ domain: "alerts.acme.com" });
    expect(r.class).toBe("bot");
  });

  it("classifies compound bot localparts like googleone-out-of-quota-noreply as bot", () => {
    const r = domainClass({
      domain: "google.com",
      localpart_for_bot_check: "googleone-out-of-quota-noreply",
    });
    expect(r.class).toBe("bot");
  });

  it("classifies ops-alerts-internal as bot (compound localpart)", () => {
    const r = domainClass({
      domain: "foo.com",
      localpart_for_bot_check: "ops-alerts-internal",
    });
    expect(r.class).toBe("bot");
  });
});

// Fix #2: forwarded-chain name stripping
describe("stripForwardedChainName", () => {
  it("returns null when SaaS vendor name on non-vendor domain", () => {
    const r = stripForwardedChainName({
      from_name: "digital ocean",
      from_email: "shamlata@cyphersol.co.in",
    });
    expect(r).toBeNull();
  });

  it("returns null for DigitalOcean (compact form) on non-vendor domain", () => {
    const r = stripForwardedChainName({
      from_name: "DigitalOcean",
      from_email: "ops@example.com",
    });
    expect(r).toBeNull();
  });

  it("keeps vendor name when on vendor's own domain", () => {
    const r = stripForwardedChainName({
      from_name: "DigitalOcean",
      from_email: "billing@digitalocean.com",
    });
    expect(r).toBe("DigitalOcean");
  });

  it("returns the name unchanged when it's a real human", () => {
    const r = stripForwardedChainName({
      from_name: "Umayr Sheik",
      from_email: "usheik@sinxsolutions.ai",
    });
    expect(r).toBe("Umayr Sheik");
  });

  it("strips 'via' wrapper: 'Jane Doe via Stripe'", () => {
    const r = stripForwardedChainName({
      from_name: "Jane Doe via Stripe",
      from_email: "jane@example.com",
    });
    expect(r).toBe("Jane Doe");
  });

  it("strips 'on behalf of' wrapper", () => {
    const r = stripForwardedChainName({
      from_name: "Jane Doe on behalf of Booking.com",
      from_email: "jane@example.com",
    });
    expect(r).toBe("Jane Doe");
  });

  it("returns null for bracket-only names", () => {
    const r = stripForwardedChainName({
      from_name: "<support@foo.com>",
      from_email: "support@foo.com",
    });
    expect(r).toBeNull();
  });

  it("returns null for empty-string name", () => {
    const r = stripForwardedChainName({
      from_name: "   ",
      from_email: "foo@bar.com",
    });
    expect(r).toBeNull();
  });

  it("returns null for null name", () => {
    const r = stripForwardedChainName({
      from_name: null,
      from_email: "foo@bar.com",
    });
    expect(r).toBeNull();
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

describe("bareLid", () => {
  it("strips :device@lid suffix", () => {
    expect(bareLid("10307938324603:28@lid")).toBe("10307938324603");
  });
  it("strips :device suffix without @lid", () => {
    expect(bareLid("10307938324603:30")).toBe("10307938324603");
  });
  it("leaves a clean lid unchanged", () => {
    expect(bareLid("10307938324603")).toBe("10307938324603");
  });
  it("strips bare @lid suffix", () => {
    expect(bareLid("10307938324603@lid")).toBe("10307938324603");
  });
  it("returns null for empty string", () => {
    expect(bareLid("")).toBeNull();
  });
  it("returns null for null/undefined", () => {
    expect(bareLid(null)).toBeNull();
    expect(bareLid(undefined)).toBeNull();
  });
  it("case-insensitive @LID suffix", () => {
    expect(bareLid("10307938324603@LID")).toBe("10307938324603");
  });
  it("integration: two suffixes resolve to same bare lid", () => {
    expect(bareLid("10307938324603:28@lid")).toBe(
      bareLid("10307938324603:30@lid"),
    );
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

// Positive-source LID rule: for @lid jids, session.db is the only valid
// phone source; contacts.phone is ignored entirely (it frequently re-echoes
// LID digits).
describe("phoneForContact", () => {
  it("returns null for @lid contact with no lidMap entry (ignores contacts.phone)", () => {
    const r = phoneForContact({
      row: { jid: "987654321098765@lid", phone: "987654321098765" },
      lidMap: new Map(),
    });
    expect(r).toBeNull();
  });

  it("returns mapped phone when lidMap has the LID", () => {
    const lidMap = new Map([["987654321098765", "+919876543210"]]);
    const r = phoneForContact({
      row: { jid: "987654321098765@lid", phone: "987654321098765" },
      lidMap,
    });
    expect(r).toBe("+919876543210");
  });

  it("normalizes missing leading + from lidMap entry", () => {
    const lidMap = new Map([["207283862659127", "971586783040"]]);
    const r = phoneForContact({
      row: { jid: "207283862659127@lid" },
      lidMap,
    });
    expect(r).toBe("+971586783040");
  });

  it("resolves via session.db when no lidMap passed", () => {
    const r = phoneForContact({
      row: { jid: "207283862659127@lid" },
      db_path_override: FIXTURE_DB,
    });
    expect(r).toBe("+971586783040");
  });

  it("returns the contact's phone for plain @s.whatsapp.net jid", () => {
    const r = phoneForContact({
      row: { jid: "971586783040@s.whatsapp.net", phone: "+971586783040" },
      lidMap: new Map(),
    });
    expect(r).toBe("+971586783040");
  });

  it("returns null for empty jid", () => {
    const r = phoneForContact({ row: {}, lidMap: new Map() });
    expect(r).toBeNull();
  });
});

describe("isResolvableLidContact", () => {
  it("rejects @lid row with no name and no lidMap bridge", () => {
    const r = isResolvableLidContact(
      { jid: "987654321098765@lid" },
      new Map(),
    );
    expect(r).toBe(false);
  });

  it("accepts @lid row with a name even without bridge", () => {
    const r = isResolvableLidContact(
      { jid: "987654321098765@lid", full_name: "Maya Krishnan" },
      new Map(),
    );
    expect(r).toBe(true);
  });

  it("accepts @lid row with lidMap bridge even without a name", () => {
    const lidMap = new Map([["987654321098765", "+919876543210"]]);
    const r = isResolvableLidContact(
      { jid: "987654321098765@lid" },
      lidMap,
    );
    expect(r).toBe(true);
  });

  it("accepts any non-@lid row (pass-through)", () => {
    const r = isResolvableLidContact(
      { jid: "971586783040@s.whatsapp.net" },
      new Map(),
    );
    expect(r).toBe(true);
  });

  it("accepts when push_name is present", () => {
    const r = isResolvableLidContact(
      { jid: "987654321098765@lid", push_name: "Umayr" },
      new Map(),
    );
    expect(r).toBe(true);
  });
});

// Fix #3: Layer 2 cross-channel fuzzy bridge
describe("decideCrossChannelMerge", () => {
  it("merges Umayr WA + Umayr Gmail", () => {
    const wa = {
      id: "wa1",
      name: "Umayr Sheik",
      phones: ["+971586783040"],
      emails: [],
      provenance: new Set(["wa_dm", "wa_contact", "wa_group"]),
    };
    const gm = {
      id: "gm1",
      name: "Umayr Sheik",
      phones: [],
      emails: ["usheik@sinxsolutions.ai"],
      provenance: new Set(["gmail_from"]),
    };
    const r = decideCrossChannelMerge({ bucket_a: wa, bucket_b: gm });
    expect(r.merge).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(0.85);
  });

  it("does NOT merge generic 'John' across channels", () => {
    const wa = {
      name: "John",
      provenance: new Set(["wa_contact"]),
    };
    const gm = {
      name: "John",
      provenance: new Set(["gmail_from"]),
    };
    const r = decideCrossChannelMerge({ bucket_a: wa, bucket_b: gm });
    expect(r.merge).toBe(false);
  });

  it("does NOT merge single-token short name 'Ram'", () => {
    const wa = { name: "Ram", provenance: new Set(["wa_contact"]) };
    const gm = { name: "Ram", provenance: new Set(["gmail_from"]) };
    const r = decideCrossChannelMerge({ bucket_a: wa, bucket_b: gm });
    expect(r.merge).toBe(false);
  });

  it("does NOT merge WA 'Amazon' with an Amazon-sender email", () => {
    const wa = { name: "Amazon", provenance: new Set(["wa_contact"]) };
    const gm = {
      name: "Amazon.in",
      provenance: new Set(["gmail_from"]),
    };
    const r = decideCrossChannelMerge({ bucket_a: wa, bucket_b: gm });
    expect(r.merge).toBe(false);
  });

  it("does NOT merge WA 'Google' label with a Google email", () => {
    const wa = { name: "Google", provenance: new Set(["wa_contact"]) };
    const gm = { name: "Google", provenance: new Set(["gmail_from"]) };
    const r = decideCrossChannelMerge({ bucket_a: wa, bucket_b: gm });
    expect(r.merge).toBe(false);
  });

  it("requires WA-only vs Gmail-only; refuses mixed buckets", () => {
    const both = {
      name: "Umayr Sheik",
      provenance: new Set(["wa_dm", "gmail_from"]),
    };
    const gm = {
      name: "Umayr Sheik",
      provenance: new Set(["gmail_from"]),
    };
    const r = decideCrossChannelMerge({ bucket_a: both, bucket_b: gm });
    expect(r.merge).toBe(false);
  });

  it("refuses to merge Umayr Sheik + Umayr Khan (only 1 token shared)", () => {
    const wa = {
      name: "Umayr Sheik",
      provenance: new Set(["wa_contact"]),
    };
    const gm = {
      name: "Umayr Khan",
      provenance: new Set(["gmail_from"]),
    };
    const r = decideCrossChannelMerge({ bucket_a: wa, bucket_b: gm });
    expect(r.merge).toBe(false);
  });

  it("refuses when one side has no name", () => {
    const wa = {
      name: null,
      provenance: new Set(["wa_contact"]),
    };
    const gm = {
      name: "Umayr Sheik",
      provenance: new Set(["gmail_from"]),
    };
    const r = decideCrossChannelMerge({ bucket_a: wa, bucket_b: gm });
    expect(r.merge).toBe(false);
  });

  it("accepts array-valued provenance (not just Set)", () => {
    const wa = {
      name: "Umayr Sheik",
      provenance: ["wa_dm", "wa_contact"],
    };
    const gm = {
      name: "Umayr Sheik",
      provenance: ["gmail_from"],
    };
    const r = decideCrossChannelMerge({ bucket_a: wa, bucket_b: gm });
    expect(r.merge).toBe(true);
  });
});

describe("crossChannelBridge (scan)", () => {
  it("finds Umayr pair in a mixed bucket list", () => {
    const buckets = [
      {
        id: "umayr-wa",
        root: "umayr-wa",
        name: "Umayr Sheik",
        provenance: new Set(["wa_dm", "wa_contact"]),
      },
      {
        id: "umayr-gm",
        root: "umayr-gm",
        name: "Umayr Sheik",
        provenance: new Set(["gmail_from"]),
      },
      {
        id: "rando",
        root: "rando",
        name: "Random Person",
        provenance: new Set(["gmail_from"]),
      },
    ];
    const pairs = crossChannelBridge({ buckets });
    expect(pairs.length).toBe(1);
    expect(pairs[0].wa_key).toBe("umayr-wa");
    expect(pairs[0].gmail_key).toBe("umayr-gm");
  });

  it("returns empty when no WA/Gmail cross pair", () => {
    const buckets = [
      {
        id: "a",
        root: "a",
        name: "A",
        provenance: new Set(["wa_contact"]),
      },
      {
        id: "b",
        root: "b",
        name: "B",
        provenance: new Set(["wa_contact"]),
      },
    ];
    const pairs = crossChannelBridge({ buckets });
    expect(pairs.length).toBe(0);
  });
});
