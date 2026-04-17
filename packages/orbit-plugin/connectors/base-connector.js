// base-connector.js — Interface that every platform connector extends.
//
// Provides the contract for both real-time (webhook) and batch (polling)
// connectors, plus stats tracking and sync checkpointing.

export class BaseConnector {
  /**
   * @param {string} name — connector identifier (e.g. "whatsapp", "gmail")
   * @param {"realtime"|"batch"} mode — how this connector ingests data
   * @param {import('../lib/identity-cache.js').IdentityCache} identityCache
   */
  constructor(name, mode, identityCache) {
    this.name = name;
    this.mode = mode;
    this.identityCache = identityCache;
    this._lastSynced = null;
    this._bootstrapped = false;
    this.stats = { processed: 0, filtered: 0, errors: 0 };
  }

  /**
   * First-run full historical sync. Called once when the plugin is
   * installed for the first time. Default: delegate to poll() with a
   * far-past since date. Connectors with expensive or paginated history
   * (e.g. WhatsApp, Gmail) should override this to implement batched
   * historical extraction.
   *
   * Returns an array of signal objects (same shape as poll()).
   *
   * @returns {Promise<Array<Object>>}
   */
  async bootstrap() {
    // Default: pull everything since the epoch. Connectors with huge
    // historical data should override and paginate.
    return this.poll(new Date(0));
  }

  /**
   * Has this connector completed its bootstrap pass?
   */
  get isBootstrapped() {
    return this._bootstrapped;
  }

  markBootstrapped() {
    this._bootstrapped = true;
  }

  /**
   * Check if this connector's data source exists on this machine.
   * @returns {boolean}
   */
  isAvailable() {
    return false;
  }

  /**
   * For batch connectors: fetch all signals since the given timestamp.
   * @param {Date} since
   * @returns {Promise<Array<Object>>} array of signal objects
   */
  async poll(since) {
    return [];
  }

  /**
   * For real-time connectors: process a single webhook event.
   * @param {Object} event — raw event payload
   * @returns {Object|null} signal object, or null if filtered
   */
  processEvent(event) {
    return null;
  }

  /**
   * Record last sync point.
   * @param {Date} timestamp
   */
  markSynced(timestamp) {
    this._lastSynced = timestamp;
  }
}
