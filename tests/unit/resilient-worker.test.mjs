import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { ResilientWorker, sliceBatches } from "../../scripts/lib/resilient-worker.mjs";

function mkTmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `rw-${tag}-`));
}

function readProgress(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "progress.json"), "utf8"));
}

function silentLogger() {
  const lines = [];
  const fn = (l) => lines.push(l);
  fn.lines = lines;
  return fn;
}

function makeClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    clock: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

function fastSleep(clock) {
  return async (ms) => {
    clock.advance(ms);
  };
}

describe("sliceBatches", () => {
  it("slices evenly and handles tail", () => {
    expect(sliceBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(sliceBatches([], 3)).toEqual([]);
  });
});

describe("ResilientWorker · happy path", () => {
  let tmp;
  beforeEach(() => {
    tmp = mkTmpDir("happy");
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("runs all batches, writes atomic progress, returns completed count", async () => {
    const clk = makeClock();
    const logger = silentLogger();
    const emitted = [];

    const worker = new ResilientWorker({
      runId: "happy-1",
      outDir: tmp,
      targets: Array.from({ length: 10 }, (_, i) => `p${i}`),
      batchSize: 3,
      concurrency: 1,
      processBatch: async (items) => {
        clk.advance(100);
        return { ok: true, outputs: items.map((x) => ({ id: x })) };
      },
      emitBatch: async (outs) => emitted.push(...outs),
      retry: { maxAttempts: 3, backoffMs: [1, 2, 3] },
      budget: { maxCostUSD: 10, maxWallMin: 10 },
      costPerBatch: 0.05,
      logger,
      clock: clk.clock,
      sleep: fastSleep(clk),
    });

    const res = await worker.run();
    expect(res.phase).toBe("done");
    expect(res.completed).toBe(10);
    expect(res.completedBatches).toBe(4);
    expect(res.quarantined).toBe(0);
    expect(emitted).toHaveLength(10);
    expect(res.cost).toBeCloseTo(0.2, 5);

    const prog = readProgress(tmp);
    expect(prog.run_id).toBe("happy-1");
    expect(prog.phase).toBe("done");
    expect(prog.completed_batches).toBe(4);
    expect(prog.completed_indices).toEqual([0, 1, 2, 3]);
    expect(prog.budget).toEqual({ maxCostUSD: 10, maxWallMin: 10 });
  });
});

describe("ResilientWorker · resume from mid-run", () => {
  let tmp;
  beforeEach(() => {
    tmp = mkTmpDir("resume");
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("picks up at the next unfinished batch and does not re-run completed ones", async () => {
    fs.writeFileSync(
      path.join(tmp, "progress.json"),
      JSON.stringify(
        {
          run_id: "resume-1",
          phase: "running",
          started_at: "2026-04-21T09:00:00.000Z",
          last_checkpoint_at: "2026-04-21T09:03:00.000Z",
          total_batches: 5,
          completed_batches: 3,
          completed_indices: [0, 1, 2],
          quarantined_batches: [],
          failed_consecutive: 0,
          cursor: "p9",
          cost_usd_so_far: 0.18,
          elapsed_ms: 120000,
          eta_ms_remaining: 80000,
          budget: { maxCostUSD: 10, maxWallMin: 30 },
          circuit_breaker_tripped: false,
          total_outputs: 9,
        },
        null,
        2,
      ),
    );

    const clk = makeClock();
    const processed = [];
    const worker = new ResilientWorker({
      runId: "resume-1",
      outDir: tmp,
      targets: Array.from({ length: 15 }, (_, i) => `p${i}`),
      batchSize: 3,
      concurrency: 1,
      processBatch: async (items, meta) => {
        processed.push({ index: meta.index, items });
        clk.advance(50);
        return { ok: true, outputs: items.map((x) => ({ id: x })) };
      },
      retry: { maxAttempts: 2, backoffMs: [1] },
      costPerBatch: 0.06,
      logger: silentLogger(),
      clock: clk.clock,
      sleep: fastSleep(clk),
    });

    const res = await worker.run();
    expect(res.phase).toBe("done");
    expect(processed.map((p) => p.index).sort()).toEqual([3, 4]);
    expect(res.completedBatches).toBe(5);
    expect(res.cost).toBeCloseTo(0.18 + 0.12, 5);

    const prog = readProgress(tmp);
    expect(prog.completed_indices).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("ResilientWorker · retry-then-succeed", () => {
  let tmp;
  beforeEach(() => {
    tmp = mkTmpDir("retrysucc");
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("retries a transient failure and succeeds before exhaustion", async () => {
    const clk = makeClock();
    const attempts = new Map();
    const worker = new ResilientWorker({
      runId: "retry-1",
      outDir: tmp,
      targets: ["a", "b", "c", "d"],
      batchSize: 2,
      concurrency: 1,
      processBatch: async (items, meta) => {
        const n = (attempts.get(meta.index) ?? 0) + 1;
        attempts.set(meta.index, n);
        if (meta.index === 0 && n < 3) {
          const err = new Error("ECONNRESET");
          err.code = "ECONNRESET";
          throw err;
        }
        clk.advance(20);
        return { ok: true, outputs: items.map((x) => ({ id: x })) };
      },
      classifyError: (err) => (err.code === "ECONNRESET" ? "TRANSIENT" : "TRANSIENT"),
      retry: { maxAttempts: 3, backoffMs: [5, 10, 20] },
      costPerBatch: 0.01,
      logger: silentLogger(),
      clock: clk.clock,
      sleep: fastSleep(clk),
    });

    const res = await worker.run();
    expect(res.phase).toBe("done");
    expect(attempts.get(0)).toBe(3);
    expect(res.quarantined).toBe(0);
    expect(res.completed).toBe(4);
  });
});

describe("ResilientWorker · retry-then-DLQ", () => {
  let tmp;
  beforeEach(() => {
    tmp = mkTmpDir("retrydlq");
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("quarantines a batch after retries exhaust and continues with the rest", async () => {
    const clk = makeClock();
    const worker = new ResilientWorker({
      runId: "dlq-1",
      outDir: tmp,
      targets: ["a", "b", "c", "d", "e", "f"],
      batchSize: 2,
      concurrency: 1,
      processBatch: async (items, meta) => {
        if (meta.index === 1) {
          const err = new Error("boom");
          err.code = "ECONNRESET";
          throw err;
        }
        clk.advance(10);
        return { ok: true, outputs: items.map((x) => ({ id: x })) };
      },
      classifyError: () => "TRANSIENT",
      retry: { maxAttempts: 3, backoffMs: [1, 2, 3] },
      circuitBreaker: { failureRateThreshold: 1.0, window: 5 },
      costPerBatch: 0.01,
      logger: silentLogger(),
      clock: clk.clock,
      sleep: fastSleep(clk),
    });

    const res = await worker.run();
    expect(res.quarantined).toBe(1);
    expect(res.completed).toBe(4);
    expect(res.phase).toBe("done");

    const q = fs.readFileSync(path.join(tmp, "quarantine.ndjson"), "utf8").trim().split("\n");
    expect(q).toHaveLength(1);
    const parsed = JSON.parse(q[0]);
    expect(parsed.index).toBe(1);
    expect(parsed.items).toBe(2);
    expect(parsed.attempts).toBe(3);
    expect(parsed.items_ref).toEqual(["c", "d"]);
  });

  it("does not retry a PERMANENT error; quarantines immediately", async () => {
    const clk = makeClock();
    let attempts = 0;
    const worker = new ResilientWorker({
      runId: "perm-1",
      outDir: tmp,
      targets: ["a", "b"],
      batchSize: 2,
      concurrency: 1,
      processBatch: async () => {
        attempts++;
        const err = new Error("bad json");
        err.code = "JSON_PARSE";
        throw err;
      },
      classifyError: (err) => (err.code === "JSON_PARSE" ? "PERMANENT" : "TRANSIENT"),
      retry: { maxAttempts: 3, backoffMs: [10, 20, 30] },
      circuitBreaker: { failureRateThreshold: 1.0, window: 5 },
      logger: silentLogger(),
      clock: clk.clock,
      sleep: fastSleep(clk),
    });
    const res = await worker.run();
    expect(attempts).toBe(1);
    expect(res.quarantined).toBe(1);
  });
});

describe("ResilientWorker · circuit breaker", () => {
  let tmp;
  beforeEach(() => {
    tmp = mkTmpDir("cb");
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("trips and halts within 5 consecutive bad batches", async () => {
    const clk = makeClock();
    const seen = [];
    const worker = new ResilientWorker({
      runId: "cb-1",
      outDir: tmp,
      targets: Array.from({ length: 30 }, (_, i) => `p${i}`),
      batchSize: 3,
      concurrency: 1,
      processBatch: async (_items, meta) => {
        seen.push(meta.index);
        const err = new Error("always fails");
        err.code = "ECONNRESET";
        throw err;
      },
      classifyError: () => "TRANSIENT",
      retry: { maxAttempts: 2, backoffMs: [1, 2] },
      circuitBreaker: { failureRateThreshold: 0.3, window: 5 },
      costPerBatch: 0.1,
      logger: silentLogger(),
      clock: clk.clock,
      sleep: fastSleep(clk),
    });

    const res = await worker.run();
    expect(res.phase).toBe("halted_circuit_breaker");
    expect(res.circuitBreakerTripped).toBe(true);
    expect(res.quarantined).toBeLessThanOrEqual(5);
    expect(res.quarantined).toBeGreaterThanOrEqual(2);
    expect(res.completed).toBe(0);

    const prog = readProgress(tmp);
    expect(prog.circuit_breaker_tripped).toBe(true);
  });
});

describe("ResilientWorker · budget ceilings", () => {
  let tmp;
  beforeEach(() => {
    tmp = mkTmpDir("budget");
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("halts when cost ceiling is reached", async () => {
    const clk = makeClock();
    const worker = new ResilientWorker({
      runId: "budget-cost",
      outDir: tmp,
      targets: Array.from({ length: 20 }, (_, i) => `p${i}`),
      batchSize: 2,
      concurrency: 1,
      processBatch: async (items) => {
        clk.advance(5);
        return { ok: true, outputs: items.map((x) => ({ id: x })) };
      },
      retry: { maxAttempts: 1, backoffMs: [1] },
      budget: { maxCostUSD: 0.25, maxWallMin: 60 },
      costPerBatch: 0.1,
      logger: silentLogger(),
      clock: clk.clock,
      sleep: fastSleep(clk),
    });

    const res = await worker.run();
    expect(res.phase).toBe("halted_budget");
    expect(res.cost).toBeGreaterThanOrEqual(0.25);
    expect(res.completedBatches).toBeLessThan(10);
  });

  it("halts when wall-clock ceiling is reached", async () => {
    const clk = makeClock();
    const worker = new ResilientWorker({
      runId: "budget-wall",
      outDir: tmp,
      targets: Array.from({ length: 20 }, (_, i) => `p${i}`),
      batchSize: 2,
      concurrency: 1,
      processBatch: async (items) => {
        clk.advance(60_000);
        return { ok: true, outputs: items.map((x) => ({ id: x })) };
      },
      retry: { maxAttempts: 1, backoffMs: [1] },
      budget: { maxCostUSD: 100, maxWallMin: 3 },
      costPerBatch: 0.1,
      logger: silentLogger(),
      clock: clk.clock,
      sleep: fastSleep(clk),
    });

    const res = await worker.run();
    expect(res.phase).toBe("halted_budget");
    expect(res.wallMinutes).toBeGreaterThanOrEqual(3);
  });
});

describe("ResilientWorker · concurrent batch failures", () => {
  let tmp;
  beforeEach(() => {
    tmp = mkTmpDir("concurrent");
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("handles failures across concurrent batches without corrupting progress", async () => {
    const clk = makeClock();
    const worker = new ResilientWorker({
      runId: "concurrent-1",
      outDir: tmp,
      targets: Array.from({ length: 20 }, (_, i) => `p${i}`),
      batchSize: 2,
      concurrency: 4,
      processBatch: async (items, meta) => {
        clk.advance(5);
        if ([2, 5, 7].includes(meta.index)) {
          const err = new Error("boom-" + meta.index);
          err.code = "JSON_PARSE";
          throw err;
        }
        return { ok: true, outputs: items.map((x) => ({ id: x })) };
      },
      classifyError: (err) => (err.code === "JSON_PARSE" ? "PERMANENT" : "TRANSIENT"),
      retry: { maxAttempts: 2, backoffMs: [1, 2] },
      circuitBreaker: { failureRateThreshold: 1.0, window: 5 },
      costPerBatch: 0.02,
      logger: silentLogger(),
      clock: clk.clock,
      sleep: fastSleep(clk),
    });

    const res = await worker.run();
    expect(res.phase).toBe("done");
    expect(res.completedBatches).toBe(7);
    expect(res.quarantined).toBe(3);
    expect(res.completed).toBe(14);

    const prog = readProgress(tmp);
    expect(prog.completed_indices).toEqual([0, 1, 3, 4, 6, 8, 9]);
    expect(prog.quarantined_batches.map((q) => q.index).sort((a, b) => a - b)).toEqual([2, 5, 7]);

    const q = fs.readFileSync(path.join(tmp, "quarantine.ndjson"), "utf8").trim().split("\n");
    expect(q).toHaveLength(3);
  });
});

describe("ResilientWorker · atomic progress writes", () => {
  let tmp;
  beforeEach(() => {
    tmp = mkTmpDir("atomic");
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("writes progress.json via tmp+rename (no stray tmp files after run)", async () => {
    const clk = makeClock();
    const worker = new ResilientWorker({
      runId: "atomic-1",
      outDir: tmp,
      targets: ["a", "b", "c", "d"],
      batchSize: 2,
      concurrency: 1,
      processBatch: async (items) => {
        clk.advance(1);
        return { ok: true, outputs: items.map((x) => ({ id: x })) };
      },
      retry: { maxAttempts: 1, backoffMs: [1] },
      logger: silentLogger(),
      clock: clk.clock,
      sleep: fastSleep(clk),
    });

    await worker.run();
    const files = fs.readdirSync(tmp);
    expect(files).toContain("progress.json");
    const strays = files.filter((f) => f.startsWith("progress.json.tmp."));
    expect(strays).toHaveLength(0);

    const raw = fs.readFileSync(path.join(tmp, "progress.json"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

describe("ResilientWorker · input validation", () => {
  it("throws structured error when options missing", () => {
    expect(() => new ResilientWorker()).toThrow(/options object is required/);
    try {
      new ResilientWorker();
    } catch (e) {
      expect(e.error).toEqual({ code: "INVALID_OPTIONS", message: "options object is required" });
    }
  });
  it("throws when processBatch is missing", () => {
    const dir = mkTmpDir("validate");
    try {
      expect(
        () =>
          new ResilientWorker({ runId: "x", outDir: dir, targets: [] }),
      ).toThrow(/processBatch/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
