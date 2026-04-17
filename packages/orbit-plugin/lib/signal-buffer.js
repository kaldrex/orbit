// signal-buffer.js — Batched signal delivery to Orbit API.
//
// Collects interaction signals from all connectors, deduplicates within a
// 5-minute window per person+channel, and flushes to the Orbit /ingest
// endpoint every 30 seconds. Retries on failure, graceful shutdown flush.

const DEFAULT_API_URL = "https://orbit-mu-roan.vercel.app/api/v1";
const FLUSH_INTERVAL_MS = 5_000;
const DEDUP_WINDOW_MS = 5 * 60_000;
const MAX_PER_FLUSH = 500;
const MAX_RETRIES = 3;

export class SignalBuffer {
  /**
   * @param {Object} opts
   * @param {string} opts.apiKey — Orbit API key (required)
   * @param {string} [opts.apiUrl] — Orbit API base URL
   * @param {Object} [opts.logger] — logger with .info/.warn/.error
   */
  constructor(opts = {}) {
    if (!opts.apiKey) throw new Error("SignalBuffer requires opts.apiKey");

    this._apiKey = opts.apiKey;
    this._apiUrl = opts.apiUrl || process.env.ORBIT_API_URL || DEFAULT_API_URL;
    this._log = opts.logger || console;

    // Queued interactions: { participants, channel, summary?, timestamp?, _retries }
    this._buffer = [];

    // Queued persons: { name, company?, email?, category? }
    this._persons = new Map(); // name → person object

    // Dedup: "personName|channel" → last signal timestamp
    this._seen = new Map();

    this._flushing = false;
    this._timer = null;
    this._shutdownHandlers = null;

    this._startFlushLoop();
    this._registerShutdownHandlers();
  }

  // ─── Public API ──────────────────────────────────────────

  /**
   * Add an interaction signal. Deduplicates same person+channel
   * within a 5-minute window.
   *
   * @param {Object} signal
   * @param {string[]} signal.participants — names of people involved
   * @param {string} signal.channel — whatsapp, email, slack, calendar, linear
   * @param {string} [signal.summary] — what was discussed
   * @param {string} [signal.timestamp] — ISO timestamp (defaults to now)
   * @param {Object[]} [signal.persons] — person metadata to upsert
   */
  add(signal) {
    if (!signal?.participants?.length || !signal?.channel) return;

    const ts = signal.timestamp || new Date().toISOString();

    // Dedup by participant+channel+day-bucket. Using the signal's own
    // timestamp (not wall-clock) means a bootstrap that dumps years of
    // history doesn't collapse into one signal per contact — we still
    // preserve one interaction per day per channel.
    const tsMs = new Date(ts).getTime() || Date.now();
    const dayBucket = Math.floor(tsMs / 86400_000);

    const dominated = signal.participants.every((p) => {
      const key = `${p}|${signal.channel}|${dayBucket}`;
      return this._seen.has(key);
    });

    if (dominated) return;

    for (const p of signal.participants) {
      this._seen.set(`${p}|${signal.channel}|${dayBucket}`, tsMs);
    }

    // Queue the interaction
    this._buffer.push({
      participants: signal.participants,
      channel: signal.channel,
      summary: signal.summary || undefined,
      timestamp: ts,
      _retries: 0,
    });

    // Queue any person metadata
    if (signal.persons) {
      for (const p of signal.persons) {
        if (p.name) this._persons.set(p.name, p);
      }
    }
  }

  /**
   * Number of pending signals.
   */
  get pending() {
    return this._buffer.length;
  }

  /**
   * Force an immediate flush (used by tests and graceful shutdown).
   */
  async flush() {
    return this._flush();
  }

  /**
   * Stop the flush loop and run a final flush.
   */
  async shutdown() {
    this._stopFlushLoop();
    this._removeShutdownHandlers();
    await this._flush();
  }

  // ─── Internal ────────────────────────────────────────────

  _startFlushLoop() {
    this._timer = setInterval(() => this._flush(), FLUSH_INTERVAL_MS);
    this._timer.unref(); // Don't keep Node alive just for the flush loop
  }

  _stopFlushLoop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _registerShutdownHandlers() {
    this._shutdownHandlers = {
      sigint: () => this._onShutdown("SIGINT"),
      sigterm: () => this._onShutdown("SIGTERM"),
    };
    process.on("SIGINT", this._shutdownHandlers.sigint);
    process.on("SIGTERM", this._shutdownHandlers.sigterm);
  }

  _removeShutdownHandlers() {
    if (this._shutdownHandlers) {
      process.removeListener("SIGINT", this._shutdownHandlers.sigint);
      process.removeListener("SIGTERM", this._shutdownHandlers.sigterm);
      this._shutdownHandlers = null;
    }
  }

  async _onShutdown(signal) {
    this._log.info?.(`[signal-buffer] ${signal} received, flushing...`);
    this._stopFlushLoop();
    this._removeShutdownHandlers();
    await this._flush();
    process.exit(0);
  }

  async _flush() {
    if (this._flushing) return;
    if (this._buffer.length === 0 && this._persons.size === 0) return;

    this._flushing = true;

    // Drain up to MAX_PER_FLUSH interactions
    const batch = this._buffer.splice(0, MAX_PER_FLUSH);
    const persons = Array.from(this._persons.values());
    this._persons.clear();

    // Clean stale dedup entries
    this._cleanDedup();

    // Strip internal fields before sending
    const interactions = batch.map(({ _retries, ...rest }) => rest);

    const body = {};
    if (interactions.length > 0) body.interactions = interactions;
    if (persons.length > 0) body.persons = persons;

    try {
      const res = await fetch(`${this._apiUrl}/ingest`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this._apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Orbit API ${res.status}: ${text.slice(0, 200)}`);
      }

      const data = await res.json();
      this._log.info?.(
        `[signal-buffer] flushed ${interactions.length} interactions, ` +
          `${persons.length} persons — accepted: ${data.accepted?.interactions ?? "?"} interactions, ` +
          `${data.accepted?.persons ?? "?"} persons`
      );
    } catch (err) {
      this._log.warn?.(
        `[signal-buffer] flush failed: ${err.message} — retrying ${batch.length} interactions`
      );

      // Put failed items back at the front, with incremented retry count
      const retryable = [];
      for (const item of batch) {
        if (item._retries < MAX_RETRIES) {
          item._retries++;
          retryable.push(item);
        } else {
          this._log.warn?.(
            `[signal-buffer] dropping interaction after ${MAX_RETRIES} retries: ` +
              `${item.participants.join(", ")} on ${item.channel}`
          );
        }
      }
      this._buffer.unshift(...retryable);

      // Put persons back too
      for (const p of persons) {
        if (!this._persons.has(p.name)) this._persons.set(p.name, p);
      }
    } finally {
      this._flushing = false;
    }
  }

  /**
   * Remove dedup entries older than the window.
   */
  _cleanDedup() {
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    for (const [key, ts] of this._seen) {
      if (ts < cutoff) this._seen.delete(key);
    }
  }
}
