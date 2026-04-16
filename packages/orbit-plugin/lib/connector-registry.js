// connector-registry.js — Discovers and orchestrates Orbit connectors.
//
// Scans the connectors/ directory for subdirectories with manifest.json,
// dynamically loads each connector, and manages batch poll intervals
// and real-time event routing.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONNECTORS_DIR = join(__dirname, "..", "connectors");

export class ConnectorRegistry {
  /**
   * @param {import('./identity-cache.js').IdentityCache} identityCache
   * @param {import('./signal-buffer.js').SignalBuffer} signalBuffer
   * @param {Object} [opts]
   * @param {Object} [opts.logger]
   */
  constructor(identityCache, signalBuffer, opts = {}) {
    this._identityCache = identityCache;
    this._signalBuffer = signalBuffer;
    this._log = opts.logger || console;

    // name → { connector, manifest }
    this._connectors = new Map();

    // name → timer ID for batch polls
    this._timers = new Map();
  }

  /**
   * Scan connectors/ directory for subdirectories with manifest.json.
   * For each, dynamically import connector.js, create an instance,
   * and call isAvailable(). Returns array of enabled connector names.
   * @returns {Promise<string[]>}
   */
  async discover() {
    const enabled = [];

    let entries;
    try {
      entries = readdirSync(CONNECTORS_DIR, { withFileTypes: true });
    } catch {
      this._log.warn?.("[connector-registry] connectors directory not found");
      return enabled;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const manifestPath = join(CONNECTORS_DIR, entry.name, "manifest.json");
      if (!existsSync(manifestPath)) continue;

      let manifest;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      } catch (err) {
        this._log.warn?.(
          `[connector-registry] failed to read manifest for ${entry.name}: ${err.message}`
        );
        continue;
      }

      const connectorPath = join(CONNECTORS_DIR, entry.name, "connector.js");
      if (!existsSync(connectorPath)) {
        this._log.warn?.(
          `[connector-registry] no connector.js in ${entry.name}`
        );
        continue;
      }

      try {
        const mod = await import(pathToFileURL(connectorPath).href);
        const ConnectorClass = mod.default || mod.Connector;
        const instance = new ConnectorClass(this._identityCache);

        if (instance.isAvailable()) {
          this._connectors.set(manifest.name, { connector: instance, manifest });
          enabled.push(manifest.name);
          this._log.info?.(
            `[connector-registry] enabled: ${manifest.displayName} (${manifest.mode})`
          );
        } else {
          this._log.info?.(
            `[connector-registry] skipped: ${manifest.displayName} (not available)`
          );
        }
      } catch (err) {
        this._log.warn?.(
          `[connector-registry] failed to load ${entry.name}: ${err.message}`
        );
      }
    }

    return enabled;
  }

  /**
   * Start batch polling for all batch-mode connectors.
   * Runs each poll immediately, then on the interval from manifest.pollIntervalHours.
   */
  startBatchPolls() {
    for (const [name, { connector, manifest }] of this._connectors) {
      if (manifest.mode !== "batch") continue;

      const intervalMs = (manifest.pollIntervalHours || 1) * 3600_000;

      // Run immediately
      this._runBatchPoll(name, connector);

      // Schedule recurring
      const timer = setInterval(
        () => this._runBatchPoll(name, connector),
        intervalMs
      );
      timer.unref();
      this._timers.set(name, timer);

      this._log.info?.(
        `[connector-registry] batch poll started: ${name} every ${manifest.pollIntervalHours}h`
      );
    }
  }

  /**
   * Route a real-time webhook event to matching connectors.
   * @param {string} eventType — e.g. "message"
   * @param {Object} payload — raw event data
   */
  handleRealtimeEvent(eventType, payload) {
    for (const [name, { connector, manifest }] of this._connectors) {
      if (manifest.mode !== "realtime") continue;
      if (manifest.webhookEvent !== eventType) continue;

      try {
        const signal = connector.processEvent(payload);
        if (signal) {
          this._pushSignal(signal);
          connector.stats.processed++;
        } else {
          connector.stats.filtered++;
        }
      } catch (err) {
        connector.stats.errors++;
        this._log.warn?.(
          `[connector-registry] ${name} event error: ${err.message}`
        );
      }
    }
  }

  /**
   * Stop all batch poll timers.
   */
  stop() {
    for (const [name, timer] of this._timers) {
      clearInterval(timer);
    }
    this._timers.clear();
  }

  /**
   * Get stats for all connectors.
   * @returns {Object} name → stats
   */
  get stats() {
    const out = {};
    for (const [name, { connector }] of this._connectors) {
      out[name] = { ...connector.stats };
    }
    return out;
  }

  // ─── Internal ────────────────────────────────────────────

  /**
   * Run a single batch poll for a connector.
   */
  async _runBatchPoll(name, connector) {
    try {
      const since = connector._lastSynced || new Date(Date.now() - 86400_000);
      const signals = await connector.poll(since);

      for (const signal of signals) {
        this._pushSignal(signal);
        connector.stats.processed++;
      }

      connector.markSynced(new Date());
      await this._signalBuffer.flush();

      this._log.info?.(
        `[connector-registry] ${name} poll: ${signals.length} signals`
      );
    } catch (err) {
      connector.stats.errors++;
      this._log.warn?.(
        `[connector-registry] ${name} poll error: ${err.message}`
      );
    }
  }

  /**
   * Translate a connector signal to the SignalBuffer.add() format.
   * Connectors return: { contactName, channel, timestamp, detail, isGroup }
   * SignalBuffer expects: { participants, channel, summary, timestamp }
   */
  _pushSignal(signal) {
    this._signalBuffer.add({
      participants: [signal.contactName],
      channel: signal.channel,
      summary: signal.detail || undefined,
      timestamp: signal.timestamp || new Date().toISOString(),
    });
  }
}
