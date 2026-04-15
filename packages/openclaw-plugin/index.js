// @orbit/openclaw-plugin
// Drop-in OpenClaw plugin that connects any agent to Orbit SaaS.
// Provides read + write tools for relationship intelligence.
//
// Setup:
//   1. Get an API key from your Orbit dashboard (/dashboard/settings)
//   2. Set ORBIT_API_KEY in your environment
//   3. Add this plugin path to openclaw.json plugins.load.paths
//   4. Add "orbit-saas" to plugins.allow and tools.alsoAllow
//
// The plugin registers 7 tools:
//   READ:  orbit_lookup, orbit_person_card, orbit_morning_brief, orbit_going_cold, orbit_graph_stats
//   WRITE: orbit_ingest, orbit_log_interaction

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let definePluginEntry;
try {
  ({ t: definePluginEntry } = require("/usr/lib/node_modules/openclaw/dist/plugin-entry-CcWmObwf.js"));
} catch {
  ({ t: definePluginEntry } = require("/opt/homebrew/lib/node_modules/openclaw/dist/plugin-entry-CcWmObwf.js"));
}

const DEFAULT_API_URL = "https://orbit-mu-roan.vercel.app/api/v1";

class OrbitClient {
  constructor(apiKey, baseUrl) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl || process.env.ORBIT_API_URL || DEFAULT_API_URL;
  }

  async get(path, params = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Orbit API ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  async post(path, body) {
    const res = await fetch(this.baseUrl + path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Orbit API ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  async patch(path, body) {
    const res = await fetch(this.baseUrl + path, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Orbit API ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }
}

function asToolText(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}

function toolError(msg) {
  return { content: [{ type: "text", text: "orbit: " + msg }], isError: true };
}

export default definePluginEntry({
  id: "orbit-saas",
  name: "Orbit SaaS — Relationship Intelligence",
  description:
    "Connect your agent to Orbit cloud. Read relationship data, push observed " +
    "interactions, get going-cold alerts, find intro paths. Set ORBIT_API_KEY.",

  register(api) {
    const apiKey = process.env.ORBIT_API_KEY;
    if (!apiKey) {
      (api.logger || console).warn(
        "[orbit-saas] ORBIT_API_KEY not set — plugin disabled. Get a key at your Orbit dashboard."
      );
      return;
    }

    const client = new OrbitClient(apiKey);
    const logger = api.logger || console;

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
        "warm contacts, going cold count, total interactions.",
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

    // ─── WRITE TOOLS ─────────────────────────────────────────

    api.registerTool({
      name: "orbit_ingest",
      description:
        "Push observed interactions to Orbit. Call this after you observe a conversation " +
        "between people — Orbit creates/updates Person nodes, logs interactions, and " +
        "creates cross-connection edges between co-participants. This is the main write " +
        "path for building the relationship graph passively.",
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
              },
              required: ["participants", "channel"],
            },
          },
          persons: {
            type: "array",
            description: "Optional: metadata about people mentioned (company, title, category)",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                company: { type: "string" },
                email: { type: "string" },
                category: { type: "string" },
                title: { type: "string" },
              },
              required: ["name"],
            },
          },
        },
        required: ["interactions"],
      },
      async execute(_id, params) {
        try {
          const data = await client.post("/ingest", params);
          logger.info && logger.info(
            `[orbit-saas] ingest: ${data.stats.personsCreated} created, ${data.stats.interactionsCreated} interactions, ${data.stats.edgesCreated} edges`
          );
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

    logger.info && logger.info(
      "[orbit-saas] registered (tools=6, read=4, write=2). API: " + client.baseUrl
    );
  },
});

export const id = "orbit-saas";
export const tools = {
  orbit_lookup: 1,
  orbit_person_card: 1,
  orbit_going_cold: 1,
  orbit_graph_stats: 1,
  orbit_ingest: 1,
  orbit_log_interaction: 1,
};
