import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_RETRY = { maxAttempts: 3, backoffMs: [5000, 20000, 60000] };
const DEFAULT_CIRCUIT = { failureRateThreshold: 0.3, window: 5 };
const DEFAULT_BUDGET = { maxCostUSD: Infinity, maxWallMin: Infinity };
const EMA_ALPHA = 0.4;

export class ResilientWorker {
  constructor(opts) {
    if (!opts || typeof opts !== "object") {
      throw workerError("INVALID_OPTIONS", "options object is required");
    }
    if (!opts.runId) throw workerError("INVALID_OPTIONS", "runId is required");
    if (!opts.outDir) throw workerError("INVALID_OPTIONS", "outDir is required");
    if (!Array.isArray(opts.targets)) {
      throw workerError("INVALID_OPTIONS", "targets must be an array");
    }
    if (typeof opts.processBatch !== "function") {
      throw workerError("INVALID_OPTIONS", "processBatch must be a function");
    }

    this.runId = opts.runId;
    this.outDir = opts.outDir;
    this.targets = opts.targets;
    this.batchSize = Math.max(1, opts.batchSize ?? 30);
    this.concurrency = Math.max(1, opts.concurrency ?? 1);
    this.processBatch = opts.processBatch;
    this.emitBatch = opts.emitBatch ?? (async () => {});
    this.classifyError = opts.classifyError ?? defaultClassify;

    this.retry = { ...DEFAULT_RETRY, ...(opts.retry ?? {}) };
    this.circuitBreaker = { ...DEFAULT_CIRCUIT, ...(opts.circuitBreaker ?? {}) };
    this.budget = { ...DEFAULT_BUDGET, ...(opts.budget ?? {}) };
    this.costPerBatch = opts.costPerBatch ?? 0;

    this.logger = opts.logger ?? defaultLogger(this.outDir);
    this.clock = opts.clock ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms)));
    this.resume = opts.resume !== false;

    this.progressPath = path.join(this.outDir, "progress.json");
    this.quarantinePath = path.join(this.outDir, "quarantine.ndjson");

    fs.mkdirSync(this.outDir, { recursive: true });

    this.batches = sliceBatches(this.targets, this.batchSize);
    this.state = this.#initialState();
    this.writeQueue = Promise.resolve();
    this.breakerHistory = [];
    this.durations = [];
    this.emaMs = null;
  }

  async run() {
    if (this.resume) this.#loadProgressIfAny();
    if (this.state.phase === "done") {
      this.logger(`[resume] run already complete; returning cached result`);
      return this.#finalResult();
    }
    this.state.phase = "running";
    if (!this.state.started_at) this.state.started_at = new Date(this.clock()).toISOString();
    this.runStartMs = this.clock();
    await this.#writeProgress();

    const pendingIndices = this.batches
      .map((_, i) => i)
      .filter((i) => !this.state.completedSet.has(i) && !this.state.quarantinedSet.has(i));

    if (pendingIndices.length === 0) {
      this.state.phase = "done";
      await this.#writeProgress();
      return this.#finalResult();
    }

    const haltReason = { reason: null };
    let cursor = 0;
    const inFlight = new Set();

    const launchNext = () => {
      while (inFlight.size < this.concurrency && cursor < pendingIndices.length && !haltReason.reason) {
        const idx = pendingIndices[cursor++];
        const p = this.#runBatchWithRetry(idx, haltReason)
          .catch((err) => {
            this.logger(`[fatal] unexpected error in batch ${idx}: ${err?.message ?? err}`);
          })
          .finally(() => {
            inFlight.delete(p);
          });
        inFlight.add(p);
      }
    };

    launchNext();
    while (inFlight.size > 0) {
      await Promise.race(inFlight);
      if (!haltReason.reason) {
        haltReason.reason = this.#checkHaltConditions();
      }
      launchNext();
    }

    if (haltReason.reason === "circuit_breaker") {
      this.state.phase = "halted_circuit_breaker";
      this.state.circuit_breaker_tripped = true;
      this.logger(`[CIRCUIT_BREAKER: ${this.#currentFailureCount()} of last ${this.circuitBreaker.window} batches failed. Halting.]`);
    } else if (haltReason.reason === "budget_cost") {
      this.state.phase = "halted_budget";
      this.logger(`[BUDGET: cost ceiling $${this.budget.maxCostUSD} reached. Halting.]`);
    } else if (haltReason.reason === "budget_wall") {
      this.state.phase = "halted_budget";
      this.logger(`[BUDGET: wall-clock ceiling ${this.budget.maxWallMin}m reached. Halting.]`);
    } else if (
      this.state.completed_batches + this.state.quarantinedSet.size === this.batches.length
    ) {
      this.state.phase = "done";
    }

    await this.#writeProgress();
    const result = this.#finalResult();
    this.logger(
      `[batch ${this.batches.length}/${this.batches.length} ${this.state.phase === "done" ? "✓ DONE" : "✗ HALTED"} · ${result.completed} enriched · elapsed ${formatDuration(result.wallMs)} · cost $${result.cost.toFixed(2)}]`,
    );
    return result;
  }

  async #runBatchWithRetry(idx, haltReason) {
    if (haltReason.reason) return;
    const batchItems = this.batches[idx];
    const batchLabel = `batch ${idx + 1}/${this.batches.length}`;
    const startMs = this.clock();

    let lastError = null;
    let outputs = null;
    let permanent = false;
    let attempt = 0;

    while (attempt < this.retry.maxAttempts) {
      attempt++;
      try {
        const res = await this.processBatch(batchItems, { index: idx, attempt });
        if (res && res.ok === false) {
          const err = res.error ?? new Error("processBatch returned ok:false");
          throw err;
        }
        outputs = res?.outputs ?? [];
        break;
      } catch (err) {
        lastError = err;
        const kind = safeClassify(this.classifyError, err);
        if (kind === "PERMANENT") {
          permanent = true;
          this.logger(
            `[${batchLabel} ✗ ${formatErr(err)} — permanent, not retrying]`,
          );
          break;
        }
        if (attempt >= this.retry.maxAttempts) {
          this.logger(
            `[${batchLabel} ✗ ${formatErr(err)} — retries exhausted (attempt ${attempt}/${this.retry.maxAttempts})]`,
          );
          break;
        }
        const wait = this.retry.backoffMs[Math.min(attempt - 1, this.retry.backoffMs.length - 1)] ?? 0;
        this.logger(
          `[${batchLabel} ⚠ ${formatErr(err)} — retrying in ${Math.round(wait / 1000)}s (attempt ${attempt + 1}/${this.retry.maxAttempts})]`,
        );
        await this.sleep(wait);
      }
    }

    const durationMs = this.clock() - startMs;

    if (outputs !== null) {
      try {
        await this.emitBatch(outputs, { index: idx, items: batchItems });
      } catch (emitErr) {
        lastError = emitErr;
        outputs = null;
        this.logger(`[${batchLabel} ✗ emitBatch failed: ${formatErr(emitErr)}]`);
      }
    }

    const ok = outputs !== null;
    this.#recordOutcome(ok);

    if (ok) {
      this.state.completed_batches++;
      this.state.completedSet.add(idx);
      this.state.failed_consecutive = 0;
      this.state.cost_usd_so_far += this.costPerBatch;
      this.state.total_outputs += outputs.length;
      this.#pushDuration(durationMs);
      const eta = this.#estimateEtaMs();
      this.state.elapsed_ms = this.clock() - this.runStartMs;
      this.state.eta_ms_remaining = eta;
      const avg = this.emaMs ? this.emaMs / 1000 : durationMs / 1000;
      const retrySuffix = attempt > 1 ? ` (after ${attempt - 1} retr${attempt - 1 === 1 ? "y" : "ies"})` : "";
      this.logger(
        `[${batchLabel} ✓ ${(durationMs / 1000).toFixed(1)}s${retrySuffix} · ${outputs.length} enriched · avg ${avg.toFixed(2)}s · ETA ~${formatDuration(eta)} · $${this.state.cost_usd_so_far.toFixed(2)}]`,
      );
    } else {
      this.state.failed_consecutive++;
      this.state.quarantinedSet.add(idx);
      const quarantineRow = {
        index: idx,
        items: batchItems.length,
        error: formatErr(lastError),
        attempts: attempt,
        permanent,
        at: new Date(this.clock()).toISOString(),
      };
      this.state.quarantined_batches.push(quarantineRow);
      fs.appendFileSync(
        this.quarantinePath,
        JSON.stringify({ ...quarantineRow, items_ref: batchItems }) + "\n",
      );
      this.logger(`[${batchLabel} ✗ ALL RETRIES FAILED → quarantined, continuing]`);
    }

    this.state.cursor = this.#computeCursor();
    await this.#writeProgress();

    if (!haltReason.reason) {
      haltReason.reason = this.#checkHaltConditions();
    }
  }

  #checkHaltConditions() {
    if (this.#breakerTripped()) return "circuit_breaker";
    if (this.state.cost_usd_so_far >= this.budget.maxCostUSD) return "budget_cost";
    const wallMin = (this.clock() - this.runStartMs) / 60000;
    if (wallMin >= this.budget.maxWallMin) return "budget_wall";
    return null;
  }

  #breakerTripped() {
    const { window, failureRateThreshold } = this.circuitBreaker;
    if (this.breakerHistory.length < window) return false;
    const recent = this.breakerHistory.slice(-window);
    const fails = recent.filter((v) => v === false).length;
    return fails / window >= failureRateThreshold;
  }

  #currentFailureCount() {
    const { window } = this.circuitBreaker;
    return this.breakerHistory.slice(-window).filter((v) => v === false).length;
  }

  #recordOutcome(ok) {
    this.breakerHistory.push(ok);
    if (this.breakerHistory.length > this.circuitBreaker.window * 4) {
      this.breakerHistory = this.breakerHistory.slice(-this.circuitBreaker.window * 4);
    }
  }

  #pushDuration(ms) {
    this.durations.push(ms);
    if (this.durations.length > 5) this.durations.shift();
    this.emaMs = this.emaMs === null ? ms : EMA_ALPHA * ms + (1 - EMA_ALPHA) * this.emaMs;
  }

  #estimateEtaMs() {
    const remaining =
      this.batches.length -
      this.state.completed_batches -
      this.state.quarantinedSet.size;
    if (remaining <= 0 || !this.emaMs) return 0;
    const effectiveConcurrency = Math.max(1, Math.min(this.concurrency, remaining));
    return Math.round((this.emaMs * remaining) / effectiveConcurrency);
  }

  #computeCursor() {
    for (let i = 0; i < this.batches.length; i++) {
      if (!this.state.completedSet.has(i) && !this.state.quarantinedSet.has(i)) {
        const first = this.batches[i][0];
        return first ?? null;
      }
    }
    return null;
  }

  #initialState() {
    return {
      run_id: this.runId,
      phase: "idle",
      started_at: null,
      last_checkpoint_at: null,
      total_batches: this.batches.length,
      completed_batches: 0,
      quarantined_batches: [],
      failed_consecutive: 0,
      cursor: this.batches[0]?.[0] ?? null,
      cost_usd_so_far: 0,
      elapsed_ms: 0,
      eta_ms_remaining: null,
      budget: {
        maxCostUSD: this.budget.maxCostUSD,
        maxWallMin: this.budget.maxWallMin,
      },
      circuit_breaker_tripped: false,
      total_outputs: 0,
      completedSet: new Set(),
      quarantinedSet: new Set(),
    };
  }

  #loadProgressIfAny() {
    if (!fs.existsSync(this.progressPath)) return;
    let raw;
    try {
      raw = fs.readFileSync(this.progressPath, "utf8");
    } catch {
      return;
    }
    let prev;
    try {
      prev = JSON.parse(raw);
    } catch {
      this.logger(`[resume] progress.json corrupted; ignoring and starting fresh`);
      return;
    }
    if (prev.run_id !== this.runId) {
      this.logger(
        `[resume] progress.json has different run_id (${prev.run_id} vs ${this.runId}); ignoring`,
      );
      return;
    }
    this.state.started_at = prev.started_at ?? null;
    this.state.total_batches = prev.total_batches ?? this.batches.length;
    this.state.completed_batches = prev.completed_batches ?? 0;
    this.state.quarantined_batches = prev.quarantined_batches ?? [];
    this.state.failed_consecutive = prev.failed_consecutive ?? 0;
    this.state.cost_usd_so_far = prev.cost_usd_so_far ?? 0;
    this.state.total_outputs = prev.total_outputs ?? 0;
    this.state.completedSet = new Set(prev.completed_indices ?? []);
    this.state.quarantinedSet = new Set(
      (prev.quarantined_batches ?? []).map((q) => q.index),
    );
    const doneCount = this.state.completedSet.size + this.state.quarantinedSet.size;
    if (doneCount >= this.batches.length) {
      this.state.phase = "done";
    }
    this.logger(
      `[Resuming at batch ${this.state.completedSet.size + this.state.quarantinedSet.size + 1} (${this.state.completedSet.size}/${this.batches.length} complete, $${this.state.cost_usd_so_far.toFixed(2)} spent so far)]`,
    );
  }

  async #writeProgress() {
    this.writeQueue = this.writeQueue.then(() => this.#writeProgressImmediate());
    return this.writeQueue;
  }

  async #writeProgressImmediate() {
    const now = this.clock();
    this.state.last_checkpoint_at = new Date(now).toISOString();
    if (this.runStartMs) this.state.elapsed_ms = now - this.runStartMs;
    const serializable = {
      run_id: this.state.run_id,
      phase: this.state.phase,
      started_at: this.state.started_at,
      last_checkpoint_at: this.state.last_checkpoint_at,
      total_batches: this.state.total_batches,
      completed_batches: this.state.completed_batches,
      completed_indices: [...this.state.completedSet].sort((a, b) => a - b),
      quarantined_batches: this.state.quarantined_batches,
      failed_consecutive: this.state.failed_consecutive,
      cursor: this.state.cursor,
      cost_usd_so_far: round2(this.state.cost_usd_so_far),
      elapsed_ms: this.state.elapsed_ms,
      eta_ms_remaining: this.state.eta_ms_remaining,
      budget: this.state.budget,
      circuit_breaker_tripped: this.state.circuit_breaker_tripped,
      total_outputs: this.state.total_outputs,
    };
    const body = JSON.stringify(serializable, null, 2) + "\n";
    const tmpPath = `${this.progressPath}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
    const fd = fs.openSync(tmpPath, "w");
    try {
      fs.writeSync(fd, body);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, this.progressPath);
  }

  #finalResult() {
    const wallMs = this.runStartMs ? this.clock() - this.runStartMs : this.state.elapsed_ms;
    return {
      completed: this.state.total_outputs,
      completedBatches: this.state.completed_batches,
      failed: this.state.quarantined_batches.length,
      quarantined: this.state.quarantined_batches.length,
      cost: round2(this.state.cost_usd_so_far),
      wallMs,
      wallMinutes: round2(wallMs / 60000),
      phase: this.state.phase,
      circuitBreakerTripped: this.state.circuit_breaker_tripped,
    };
  }
}

export function sliceBatches(items, batchSize) {
  const out = [];
  for (let i = 0; i < items.length; i += batchSize) out.push(items.slice(i, i + batchSize));
  return out;
}

function defaultClassify(err) {
  if (!err) return "TRANSIENT";
  const status = err.status ?? err.statusCode;
  if (err.code === "JSON_PARSE" || status === 400) return "PERMANENT";
  if (err.code === "ECONNRESET" || err.code === "ETIMEDOUT" || (status >= 500 && status < 600)) {
    return "TRANSIENT";
  }
  return "TRANSIENT";
}

function safeClassify(classifier, err) {
  try {
    const v = classifier(err);
    return v === "PERMANENT" ? "PERMANENT" : "TRANSIENT";
  } catch {
    return "TRANSIENT";
  }
}

function workerError(code, message, suggestion) {
  const e = new Error(message);
  e.error = { code, message, ...(suggestion ? { suggestion } : {}) };
  return e;
}

function defaultLogger(outDir) {
  const logPath = path.join(outDir, "run.log");
  return (line) => {
    const stamped = `[${new Date().toISOString()}] ${line}`;
    process.stdout.write(stamped + "\n");
    try {
      fs.appendFileSync(logPath, stamped + "\n");
    } catch {}
  };
}

function formatErr(err) {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  const code = err.code ?? err.status ?? "";
  const msg = err.message ?? String(err);
  return code ? `${code} ${msg}` : msg;
}

function formatDuration(ms) {
  if (!ms || ms < 0) return "0s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
