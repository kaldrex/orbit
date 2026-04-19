import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { normalizePhone } from "./lib/phone.mjs";
import { canonicalizeEmail } from "./lib/email.mjs";
import { domainClass } from "./lib/domain.mjs";
import { lidToPhone } from "./lib/lid.mjs";
import { fuzzyMatch } from "./lib/fuzzy.mjs";

// The openclaw runtime bundles plugin-entry under dist/plugin-entry-<hash>.js
// and exports it aliased as `t` (not `definePluginEntry`). We glob for the
// filename so we survive hash rotations across openclaw releases.
const require = createRequire(import.meta.url);

function findPluginEntryFile() {
  const candidates = [
    "/usr/lib/node_modules/openclaw/dist",
    "/opt/homebrew/lib/node_modules/openclaw/dist",
  ];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    const file = fs
      .readdirSync(dir)
      .find((f) => /^plugin-entry-.*\.js$/.test(f));
    if (file) return path.join(dir, file);
  }
  throw new Error(
    "orbit-rules: openclaw plugin-entry runtime not found (checked /usr/lib and /opt/homebrew)",
  );
}

const { t: definePluginEntry } = require(findPluginEntryFile());

// Each execute() returns the MCP-shaped envelope: one text content
// block whose text is JSON.stringify(result). The agent parses the
// JSON on receipt.
function envelope(result) {
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

export default definePluginEntry({
  id: "orbit-rules",
  name: "Orbit Rules",
  description:
    "Stateless deterministic rules used by the orbit-observer and orbit-resolver skills.",
  register(api) {
    api.registerTool({
      name: "orbit_rules_normalize_phone",
      description:
        "Canonicalize a phone string (raw, jid, formatted) to E.164. Returns {e164, country_code, valid, original}.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          phone: { type: "string" },
          default_country: {
            type: "string",
            description:
              "ISO 3166-1 alpha-2 country code for ambiguous local numbers. Default: IN (override with ORBIT_RULES_DEFAULT_COUNTRY env or per-call).",
          },
        },
        required: ["phone"],
      },
      execute: async (_id, params) => envelope(normalizePhone(params ?? {})),
    });

    api.registerTool({
      name: "orbit_rules_canonicalize_email",
      description:
        "Lowercase + strip +suffix + collapse gmail-family aliases. Returns {canonical, domain, valid, original}.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { email: { type: "string" } },
        required: ["email"],
      },
      execute: async (_id, params) => envelope(canonicalizeEmail(params ?? {})),
    });

    api.registerTool({
      name: "orbit_rules_domain_class",
      description:
        "Classify a domain as personal|work|bot|saas|press|other. Optional localpart_for_bot_check lets you hand a full email so we can inspect the local-part for bot patterns. Returns {class, confidence, evidence}.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          domain: { type: "string" },
          localpart_for_bot_check: {
            type: "string",
            description:
              "Optional local-part (before @) to also scan for 'noreply@', 'alerts@', etc. patterns.",
          },
        },
        required: ["domain"],
      },
      execute: async (_id, params) => envelope(domainClass(params ?? {})),
    });

    api.registerTool({
      name: "orbit_rules_lid_to_phone",
      description:
        "Resolve a WhatsApp LID to its paired phone number via whatsmeow_lid_map in ~/.wacli/session.db (or WACLI_SESSION_DB env override). Accepts '<lid>' or '<lid>@lid'. Returns {phone, source_path}.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          lid: { type: "string" },
          lid_map_source: {
            type: "string",
            enum: ["wacli_session_db"],
            description: "Which map source to query; only one supported today.",
          },
        },
        required: ["lid"],
      },
      execute: async (_id, params) => envelope(lidToPhone(params ?? {})),
    });

    api.registerTool({
      name: "orbit_rules_fuzzy_match",
      description:
        "Fuzzy score two human names (0..1). Combines Jaro-Winkler (handles typos) and token-set-sort (handles missing/extra tokens like 'Umayr' vs 'Umayr Sheik'). Returns {score, reason}.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          name_a: { type: "string" },
          name_b: { type: "string" },
        },
        required: ["name_a", "name_b"],
      },
      execute: async (_id, params) => envelope(fuzzyMatch(params ?? {})),
    });
  },
});
