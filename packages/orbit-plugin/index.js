// index.js — Orbit plugin for OpenClaw.
//
// Combines:
// 1. Connector lifecycle (identity cache, signal buffer, 5 platform connectors)
// 2. Agent tools (4 read, 2 write, 1 status)
//
// Uses the register(api) pattern for tool registration with fire-and-forget
// async setup for connectors.

import { createRequire } from "node:module";
import { IdentityCache } from "./lib/identity-cache.js";
import { SignalBuffer } from "./lib/signal-buffer.js";
import { ConnectorRegistry } from "./lib/connector-registry.js";
import { OrbitClient, asToolText, toolError } from "./lib/orbit-client.js";
import { introspectCapabilities } from "./lib/capabilities.js";
import { PreMeetingBrief } from "./lib/pre-meeting-brief.js";
import { GoingColdDigest } from "./lib/going-cold-digest.js";

const CAPABILITY_REPORT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

const require = createRequire(import.meta.url);

let definePluginEntry;
try {
  ({ t: definePluginEntry } = require("/usr/lib/node_modules/openclaw/dist/plugin-entry-CcWmObwf.js"));
} catch {
  ({ t: definePluginEntry } = require("/opt/homebrew/lib/node_modules/openclaw/dist/plugin-entry-CcWmObwf.js"));
}

// Allowed categories — reject anything outside this list
const VALID_CATEGORIES = new Set([
  "team", "investor", "sponsor", "fellow", "media",
  "community", "founder", "friend", "press", "other",
]);

function normalizeCategory(cat) {
  if (!cat) return "other";
  const lower = cat.toLowerCase().trim();
  if (VALID_CATEGORIES.has(lower)) return lower;
  // Map common mistakes
  if (lower.includes("whatsapp") || lower.includes("contact")) return "other";
  if (lower.includes("calendar") || lower.includes("meeting")) return "other";
  if (lower.includes("network")) return "fellow";
  return "other";
}

export default definePluginEntry({
  id: "orbit-saas",
  name: "Orbit SaaS — Relationship Intelligence",
  description:
    "Auto-builds your relationship graph from WhatsApp, Calendar, Gmail, Slack, Linear. " +
    "Query contacts, get going-cold alerts, add relationship context.",

  register(api) {
    const apiKey = process.env.ORBIT_API_KEY;
    if (!apiKey) {
      (api.logger || console).warn(
        "[orbit] ORBIT_API_KEY not set — plugin disabled. Get a key from your Orbit dashboard."
      );
      return;
    }

    const client = new OrbitClient(apiKey);
    const logger = api.logger || console;

    // ─── CONNECTOR LIFECYCLE (async, fire-and-forget) ──────────
    let registry = null;
    let identityCache = null;
    let signalBuffer = null;
    let setupDone = false;

    (async () => {
      try {
        identityCache = new IdentityCache();
        await identityCache.load();
        logger.info(
          `[orbit] identity cache: ${identityCache.stats.contacts} contacts, ` +
          `${identityCache.stats.lidMappings} LID mappings`
        );

        signalBuffer = new SignalBuffer({ apiKey, apiUrl: client.baseUrl });

        registry = new ConnectorRegistry(identityCache, signalBuffer);
        const enabled = await registry.discover();
        logger.info(`[orbit] connectors enabled: ${enabled.join(", ") || "none"}`);

        registry.startBatchPolls();
        setupDone = true;

        // Report capabilities on startup and every 30 min thereafter
        const sendCapabilityReport = async () => {
          try {
            const caps = introspectCapabilities();
            await client.post("/capabilities", caps);
            logger.info(
              `[orbit] capability report sent: channels=${
                Object.entries(caps.channels).filter(([, v]) => v).map(([k]) => k).join(",") || "none"
              }`
            );
          } catch (err) {
            logger.warn("[orbit] capability report failed:", err.message);
          }
        };
        sendCapabilityReport();
        setInterval(sendCapabilityReport, CAPABILITY_REPORT_INTERVAL_MS).unref?.();

        // Start founder-value workers (opt-in via env vars)
        if (process.env.ORBIT_ENABLE_BRIEFS !== "false") {
          const preMeeting = new PreMeetingBrief({ orbitClient: client, logger });
          preMeeting.start();
        }
        if (process.env.ORBIT_ENABLE_DIGEST !== "false") {
          const digest = new GoingColdDigest({ orbitClient: client, logger });
          digest.start();
        }
      } catch (err) {
        logger.error("[orbit] connector setup failed:", err);
      }
    })();

    // ─── READ TOOLS ──────────────────────────────────────────

    api.registerTool({
      name: "orbit_lookup",
      description:
        "Search for a person by name or company in the relationship graph. " +
        "Returns matching contacts with scores and categories.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Name or company to search for" },
          category: { type: "string", description: "Filter by category (investor, media, founder, etc.)" },
          limit: { type: "number", description: "Max results (default 10)" },
        },
        required: ["query"],
      },
      async execute(_id, params) {
        try {
          const data = await client.get("/persons", {
            q: params.query,
            category: params.category,
            limit: params.limit || 10,
          });
          return asToolText(data);
        } catch (e) {
          return toolError(e.message);
        }
      },
    });

    api.registerTool({
      name: "orbit_person_card",
      description:
        "Get full profile for a person: score, category, company, recent interactions, " +
        "shared connections. Use after orbit_lookup to get the person_id.",
      parameters: {
        type: "object",
        properties: {
          person_id: { type: "string", description: "Person ID from orbit_lookup results" },
        },
        required: ["person_id"],
      },
      async execute(_id, params) {
        try {
          const data = await client.get(`/persons/${params.person_id}`);
          return asToolText(data);
        } catch (e) {
          return toolError(e.message);
        }
      },
    });

    api.registerTool({
      name: "orbit_going_cold",
      description:
        "Get contacts that are going cold — high relationship score but no recent interaction. " +
        "Use this proactively to surface reconnect opportunities.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max contacts to return (default 5)" },
          days: { type: "number", description: "Days threshold for 'cold' (default 14)" },
        },
      },
      async execute(_id, params) {
        try {
          const data = await client.get("/briefs", {
            limit: params?.limit || 5,
            days: params?.days || 14,
          });
          return asToolText(data);
        } catch (e) {
          return toolError(e.message);
        }
      },
    });

    api.registerTool({
      name: "orbit_graph_stats",
      description:
        "Get high-level stats about the relationship graph: total contacts, " +
        "warm contacts, going cold count, total interactions. Call this at the " +
        "start of every conversation to understand the user's relationship landscape.",
      parameters: { type: "object", properties: {} },
      async execute() {
        try {
          const data = await client.get("/graph");
          return asToolText(data);
        } catch (e) {
          return toolError(e.message);
        }
      },
    });

    // ─── STATUS TOOL ─────────────────────────────────────────

    api.registerTool({
      name: "orbit_status",
      description:
        "Check Orbit connector status — which platforms are connected, identity " +
        "cache health, pending signals. Call this to diagnose issues or guide setup.",
      parameters: { type: "object", properties: {} },
      async execute() {
        if (!setupDone) {
          return asToolText({
            status: "initializing",
            message: "Connectors are still starting up. Try again in a few seconds.",
          });
        }

        const connectorStats = registry.stats;
        const cacheStats = identityCache.stats;
        const pending = signalBuffer.pending;

        const allConnectors = ["whatsapp", "calendar", "gmail", "slack", "linear"];
        const enabled = Object.keys(connectorStats);
        const setupGuide = {};
        for (const name of allConnectors) {
          if (!enabled.includes(name)) {
            const guides = {
              whatsapp: "Install wacli (github.com/steipete/wacli) and run 'wacli auth' to link WhatsApp, or set up GOWA",
              calendar: "Install gws CLI and run 'gws auth login' to authenticate with Google Workspace",
              gmail: "Install gws CLI and run 'gws auth login' to authenticate with Google Workspace",
              slack: "Set SLACK_BOT_TOKEN environment variable with your Slack bot token",
              linear: "Set LINEAR_API_TOKEN environment variable with your Linear API key",
            };
            setupGuide[name] = guides[name];
          }
        }

        return asToolText({
          status: "running",
          connectors: Object.fromEntries(
            enabled.map(name => [name, { enabled: true, ...connectorStats[name] }])
          ),
          identityCache: cacheStats,
          signalBuffer: { pending },
          ...(Object.keys(setupGuide).length > 0 ? { setupGuide } : {}),
        });
      },
    });

    // ─── WRITE TOOLS ─────────────────────────────────────────

    api.registerTool({
      name: "orbit_ingest",
      description:
        "Push observed interactions to Orbit. Call this after you observe a conversation " +
        "between people. IMPORTANT: every person in the persons array MUST also appear " +
        "in at least one interaction's participants array, otherwise they become orphan " +
        "nodes with no edges. Only ingest real humans, never companies or organizations.",
      parameters: {
        type: "object",
        properties: {
          interactions: {
            type: "array",
            description: "List of observed interactions",
            items: {
              type: "object",
              properties: {
                participants: {
                  type: "array", items: { type: "string" },
                  description: "Names of people in the conversation (NOT the user — just their contacts)",
                },
                channel: { type: "string", description: "slack, whatsapp, email, telegram, imessage, meeting" },
                summary: { type: "string", description: "Brief summary of what was discussed" },
                topic: { type: "string", description: "Main topic (fundraising, hiring, product, etc.)" },
                timestamp: { type: "string", description: "ISO timestamp of the interaction" },
                relationship_context: { type: "string", description: "Why this interaction matters" },
                connection_context: { type: "string", description: "How participants know each other" },
                sentiment: { type: "string", description: "positive, neutral, or negative" },
              },
              required: ["participants", "channel"],
            },
          },
          persons: {
            type: "array",
            description: "Metadata about people mentioned. Each person MUST appear in interactions.participants.",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                company: { type: "string" },
                email: { type: "string" },
                category: { type: "string", description: "team, investor, sponsor, fellow, media, community, founder, friend, press, other" },
                title: { type: "string" },
                relationship_to_me: { type: "string" },
              },
              required: ["name"],
            },
          },
        },
        required: ["interactions"],
      },
      async execute(_id, params) {
        try {
          // Normalize categories to prevent Wazowski from inventing new ones
          if (params.persons) {
            for (const p of params.persons) {
              if (p.category) {
                p.category = normalizeCategory(p.category);
              }
            }
          }

          // Filter persons to only those who appear in interactions (prevent orphans)
          if (params.persons && params.interactions) {
            const participantNames = new Set();
            for (const ix of params.interactions) {
              for (const name of ix.participants || []) {
                participantNames.add(name.trim().toLowerCase());
              }
            }
            const before = params.persons.length;
            params.persons = params.persons.filter(p =>
              participantNames.has(p.name.trim().toLowerCase())
            );
            const dropped = before - params.persons.length;
            if (dropped > 0) {
              logger.info(`[orbit] dropped ${dropped} orphan persons not in any interaction`);
            }
          }

          const data = await client.post("/ingest", params);
          return asToolText(data);
        } catch (e) {
          return toolError(e.message);
        }
      },
    });

    api.registerTool({
      name: "orbit_log_interaction",
      description:
        "Log a single interaction with a specific person. Use when the full ingest " +
        "endpoint is overkill — e.g. you just had a quick DM exchange.",
      parameters: {
        type: "object",
        properties: {
          person_id: { type: "string", description: "Person ID" },
          channel: { type: "string", description: "slack, whatsapp, email, etc." },
          summary: { type: "string", description: "What was discussed" },
          topic: { type: "string", description: "Main topic" },
          direction: { type: "string", enum: ["inbound", "outbound", "both"], description: "Who initiated" },
        },
        required: ["person_id", "channel"],
      },
      async execute(_id, params) {
        try {
          const data = await client.post(`/persons/${params.person_id}/interactions`, {
            channel: params.channel,
            summary: params.summary,
            topic: params.topic,
            direction: params.direction || "both",
          });
          return asToolText(data);
        } catch (e) {
          return toolError(e.message);
        }
      },
    });

    api.registerTool({
      name: "orbit_network_search",
      description:
        "Search the user's relationship network. Use this when the user asks " +
        "'who do I know at X?', 'who in my network works at Y?', or 'find someone " +
        "who does Z'. Returns direct contacts matching the query, plus intro " +
        "paths through the user's network for contacts they don't know directly.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Company name, person name, role, or topic to search for",
          },
          limit: {
            type: "number",
            description: "Max direct matches to return (default 10, max 50)",
          },
        },
        required: ["query"],
      },
      async execute(_id, params) {
        try {
          const data = await client.get("/search", {
            q: params.query,
            limit: params.limit,
          });
          return asToolText(data);
        } catch (e) {
          return toolError(e.message);
        }
      },
    });

    logger.info(
      `[orbit] registered (tools=8, read=5, write=2, status=1). API: ${client.baseUrl}`
    );
  },
});

export const id = "orbit-saas";
export const tools = {
  orbit_lookup: 1,
  orbit_person_card: 1,
  orbit_going_cold: 1,
  orbit_graph_stats: 1,
  orbit_status: 1,
  orbit_ingest: 1,
  orbit_log_interaction: 1,
};
