// index.js — Orbit plugin entry point for OpenClaw.
//
// Lifecycle: load identity cache → discover connectors → start buffer → run.
// Handles webhook routing for real-time connectors and graceful shutdown.

import { createRequire } from "node:module";
import { IdentityCache } from "./lib/identity-cache.js";
import { SignalBuffer } from "./lib/signal-buffer.js";
import { ConnectorRegistry } from "./lib/connector-registry.js";

const require = createRequire(import.meta.url);

let definePluginEntry;
try {
  ({ t: definePluginEntry } = require("/usr/lib/node_modules/openclaw/dist/plugin-entry-CcWmObwf.js"));
} catch {
  ({ t: definePluginEntry } = require("/opt/homebrew/lib/node_modules/openclaw/dist/plugin-entry-CcWmObwf.js"));
}

export default definePluginEntry({
  name: "orbit-saas",
  async setup(ctx) {
    const apiKey = ctx.config.ORBIT_API_KEY;
    if (!apiKey) {
      console.error("[orbit] ORBIT_API_KEY is required — plugin disabled.");
      return;
    }
    const apiUrl =
      ctx.config.ORBIT_API_URL ||
      "https://orbit-mu-roan.vercel.app/api/v1";

    // 1. Load identity cache (WhatsApp contacts, LID mappings, emails)
    const identityCache = new IdentityCache();
    await identityCache.load();
    console.info(
      `[orbit] identity cache loaded — ${identityCache.stats.contacts} contacts, ` +
        `${identityCache.stats.lidMappings} LID mappings, ${identityCache.stats.emails} emails`
    );

    // 2. Create signal buffer (starts its own flush loop on construction)
    const signalBuffer = new SignalBuffer({ apiKey, apiUrl });

    // 3. Discover connectors
    const registry = new ConnectorRegistry(identityCache, signalBuffer);
    const enabled = await registry.discover();
    console.info(`[orbit] connectors enabled: ${enabled.join(", ") || "none"}`);

    // 4. Start batch polling timers
    registry.startBatchPolls();

    // 5. Route real-time webhook events to connectors
    ctx.onWebhook?.("*", (eventType, payload) => {
      registry.handleRealtimeEvent(eventType, payload);
    });

    // 6. Graceful shutdown: stop polls, flush pending signals
    ctx.onShutdown?.(async () => {
      console.info("[orbit] shutting down...");
      registry.stop();
      await signalBuffer.shutdown();
      console.info("[orbit] shutdown complete.");
    });
  },
  tools: [],
});
