import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  computeWeight,
  computeSharedGroupWeight,
  recencyFactor,
} from "../../src/lib/neo4j-writes";

// ---------------------------------------------------------------------------
// Mock factory -- each test resets rpcResponses to shape the RPC fake.
// ---------------------------------------------------------------------------

const getAuthMock = vi.fn();
const rpcResponses: Record<string, { data: unknown; error: unknown }> = {};
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

const withWriteSessionMock = vi.fn();

vi.mock("@/lib/api-auth", () => ({
  getAgentOrSessionAuth: getAuthMock,
}));

vi.mock("@/lib/neo4j", () => ({
  withWriteSession: (fn: (session: unknown) => unknown) =>
    withWriteSessionMock(fn),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return rpcResponses[name] ?? { data: [], error: null };
    },
  }),
}));

const { POST: postPopulate } = await import(
  "../../src/app/api/v1/graph/populate/route"
);

function req(init?: RequestInit): Request {
  return new Request("http://localhost/api/v1/graph/populate", {
    method: "POST",
    ...init,
  });
}

// ---------------------------------------------------------------------------
// Fake Neo4j session that records run() calls so we can assert idempotency
// (same inputs -> same Cypher payloads on run N and run N+1).
// ---------------------------------------------------------------------------

interface FakeSession {
  runs: Array<{ cypher: string; params: Record<string, unknown> }>;
  run: (cypher: string, params?: Record<string, unknown>) => Promise<{
    records: Array<{ get: (k: string) => number }>;
  }>;
}

function newFakeSession(): FakeSession {
  const s: FakeSession = {
    runs: [],
    run: async (cypher: string, params?: Record<string, unknown>) => {
      s.runs.push({ cypher, params: params ?? {} });
      // prune-path Cypher returns count; other paths don't read records.
      return {
        records: [{ get: (_k: string) => 0 }],
      };
    },
  };
  return s;
}

function happyPath() {
  rpcResponses.select_graph_nodes = {
    data: [
      {
        id: "00000000-0000-0000-0000-000000000001",
        name: "Sanchay Thalnerkar",
        category: "founder",
        company: "Orbit",
        title: null,
        relationship_to_me: "",
        phone_count: 1,
        email_count: 1,
        first_seen: "2025-01-01T00:00:00Z",
        last_seen: "2026-04-20T00:00:00Z",
      },
      {
        id: "00000000-0000-0000-0000-000000000002",
        name: "Umayr Sheik",
        category: "team",
        company: "SinX",
        title: "Founder",
        relationship_to_me: "Close friend",
        phone_count: 1,
        email_count: 3,
        first_seen: "2025-02-13T00:00:00Z",
        last_seen: "2026-04-16T00:00:00Z",
      },
    ],
    error: null,
  };
  rpcResponses.select_phone_person_map = {
    data: [
      {
        phone: "+919136820958",
        person_id: "00000000-0000-0000-0000-000000000001",
      },
      {
        phone: "+971586783040",
        person_id: "00000000-0000-0000-0000-000000000002",
      },
    ],
    error: null,
  };
  rpcResponses.select_dm_thread_stats = {
    data: [
      {
        thread_phone: "+971586783040",
        msg_count: 100,
        first_at: "2025-02-13T00:00:00Z",
        last_at: "2026-04-16T00:00:00Z",
      },
    ],
    error: null,
  };
  rpcResponses.select_group_thread_phones = {
    data: [
      {
        thread_id: "abc@g.us",
        phone: "+971586783040",
        last_at: "2026-04-01T00:00:00Z",
        msg_count: 5,
      },
    ],
    error: null,
  };
  rpcResponses.select_email_interactions = {
    data: [
      {
        person_id: "00000000-0000-0000-0000-000000000002",
        msg_count: 3,
        first_at: "2025-02-13T00:00:00Z",
        last_at: "2025-05-15T00:00:00Z",
      },
    ],
    error: null,
  };
}

// ---------------------------------------------------------------------------

describe("POST /api/v1/graph/populate", () => {
  beforeEach(() => {
    getAuthMock.mockReset();
    withWriteSessionMock.mockReset();
    rpcCalls.length = 0;
    for (const k of Object.keys(rpcResponses)) delete rpcResponses[k];
    process.env.ORBIT_SELF_EMAIL = "sanchaythalnerkar@gmail.com";
    getAuthMock.mockResolvedValue({ userId: "user-1", selfNodeId: null });
  });

  it("401 when not authenticated", async () => {
    getAuthMock.mockResolvedValueOnce(null);
    const res = await postPopulate(req());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("503 when Neo4j is unreachable", async () => {
    happyPath();
    withWriteSessionMock.mockImplementation(async () => {
      const err = new Error("cannot connect") as Error & { code: string };
      err.code = "ServiceUnavailable";
      throw err;
    });
    const res = await postPopulate(req());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("NEO4J_UNAVAILABLE");
  });

  it("502 when a Postgres RPC returns an error", async () => {
    happyPath();
    rpcResponses.select_graph_nodes = {
      data: null,
      error: { message: "boom" },
    };
    withWriteSessionMock.mockImplementation(async (_fn: (s: FakeSession) => Promise<void>) => {
      throw new Error("should not reach neo4j");
    });
    const res = await postPopulate(req());
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("READ_FAILED");
  });

  it("succeeds end-to-end with nodes + edges counted", async () => {
    happyPath();
    withWriteSessionMock.mockImplementation(async (fn: (s: FakeSession) => Promise<void>) => {
      const s = newFakeSession();
      return fn(s);
    });
    const res = await postPopulate(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodes_written).toBe(2);
    // DM edge (self<->Umayr), 0 SHARED_GROUP (only one participant), 1 EMAILED.
    // self is resolved via ORBIT_SELF_EMAIL -> name prefix match.
    expect(body.breakdown.dm).toBe(1);
    expect(body.breakdown.emailed).toBe(1);
    expect(typeof body.elapsed_ms).toBe("number");
    expect(body.self_person_id).toBe(
      "00000000-0000-0000-0000-000000000001",
    );
  });

  it("is idempotent: two runs on same inputs produce same write payloads", async () => {
    happyPath();
    const capturedRuns: Array<Array<{ cypher: string; params: Record<string, unknown> }>> = [];
    withWriteSessionMock.mockImplementation(async (fn: (s: FakeSession) => Promise<void>) => {
      const s = newFakeSession();
      await fn(s);
      capturedRuns.push(s.runs);
    });

    const res1 = await postPopulate(req());
    const body1 = await res1.json();

    const res2 = await postPopulate(req());
    const body2 = await res2.json();

    expect(body1.nodes_written).toBe(body2.nodes_written);
    expect(body1.edges_written).toBe(body2.edges_written);
    expect(body1.breakdown).toEqual(body2.breakdown);

    // Cypher strings (MERGE-based) must be byte-identical between runs.
    expect(capturedRuns).toHaveLength(2);
    const run1Cyphers = capturedRuns[0].map((r) => r.cypher);
    const run2Cyphers = capturedRuns[1].map((r) => r.cypher);
    expect(run1Cyphers).toEqual(run2Cyphers);

    // The run_at timestamp differs between runs -- that's the only
    // non-deterministic field. Node IDs and edge pair IDs must match.
    const run1Rows = capturedRuns[0]
      .map((r) => r.params.rows)
      .filter(Array.isArray);
    const run2Rows = capturedRuns[1]
      .map((r) => r.params.rows)
      .filter(Array.isArray);
    expect(run1Rows.length).toBe(run2Rows.length);
    for (let i = 0; i < run1Rows.length; i++) {
      // Both updated_at (run wall-clock) and weight (depends on
      // Date.now() via recency) are wall-clock sensitive. Strip them
      // before comparing -- idempotency is about MERGE targets, not
      // these two derived fields.
      const strip = (x: Record<string, unknown>) => {
        const { updated_at: _u, weight: _w, ...rest } = x;
        return rest;
      };
      const r1 = (run1Rows[i] as Array<Record<string, unknown>>).map(strip);
      const r2 = (run2Rows[i] as Array<Record<string, unknown>>).map(strip);
      expect(r1).toEqual(r2);
    }
  });
});

// ---------------------------------------------------------------------------
// Pure-function weight tests (doc 18 formula).
// ---------------------------------------------------------------------------

describe("edge weight formula", () => {
  it("recencyFactor = 1 at 0 days, drops to e^-1 at 180 days", () => {
    expect(recencyFactor(0)).toBeCloseTo(1, 5);
    expect(recencyFactor(180)).toBeCloseTo(Math.E ** -1, 5);
    expect(recencyFactor(360)).toBeCloseTo(Math.E ** -2, 5);
  });

  it("recencyFactor clamps negative days to 0", () => {
    expect(recencyFactor(-10)).toBe(1);
  });

  it("computeWeight = 0 when count is 0", () => {
    expect(computeWeight(0, "2026-04-20T00:00:00Z")).toBe(0);
  });

  it("computeWeight follows log(1+count) * exp(-days/180)", () => {
    const now = new Date("2026-04-20T00:00:00Z");
    const lastAt = "2026-04-20T00:00:00Z"; // 0 days ago
    expect(computeWeight(10, lastAt, now)).toBeCloseTo(Math.log(11), 5);

    const lastAt180 = "2025-10-22T00:00:00Z"; // ~180 days ago
    const w = computeWeight(10, lastAt180, now);
    // exp(-1) * log(11) ± small rounding from integer days
    expect(w).toBeGreaterThan(0);
    expect(w).toBeLessThan(Math.log(11));
  });

  it("computeSharedGroupWeight uses the same formula as computeWeight", () => {
    const now = new Date("2026-04-20T00:00:00Z");
    expect(computeSharedGroupWeight(3, "2026-04-20T00:00:00Z", now)).toBeCloseTo(
      computeWeight(3, "2026-04-20T00:00:00Z", now),
      5,
    );
  });

  it("computeWeight handles null lastAt as 0 days", () => {
    // No lastAt -> treat as fresh (0 days since).
    const w = computeWeight(5, null);
    expect(w).toBeCloseTo(Math.log(6), 5);
  });
});
