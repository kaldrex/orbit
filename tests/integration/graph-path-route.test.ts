import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Shared mocks. The route runs inside `withReadSession(fn)`; we fake that
// with a scripted session whose .run() returns canned records per query.
// ---------------------------------------------------------------------------

const getAuthMock = vi.fn();

vi.mock("@/lib/api-auth", () => ({
  getAgentOrSessionAuth: getAuthMock,
}));

// ---------------------------------------------------------------------------
// Scripted session: .run(cypher, params) matches a regex against the cypher
// and returns the first matching fixture. Keeps tests declarative.
// ---------------------------------------------------------------------------

interface ScriptEntry {
  match: RegExp;
  respond: (params?: Record<string, unknown>) =>
    | { records: Array<{ get: (k: string) => unknown }> }
    | Promise<{ records: Array<{ get: (k: string) => unknown }> }>;
}

function makeSession(entries: ScriptEntry[]) {
  const calls: Array<{ cypher: string; params: Record<string, unknown> }> = [];
  const run = async (cypher: string, params?: Record<string, unknown>) => {
    calls.push({ cypher, params: params ?? {} });
    for (const e of entries) {
      if (e.match.test(cypher)) return e.respond(params);
    }
    return { records: [] };
  };
  return { session: { run }, calls };
}

function record(obj: Record<string, unknown>) {
  return {
    get: (k: string) => obj[k],
  };
}

let pendingSession: ReturnType<typeof makeSession> | null = null;
const withReadSessionMock = vi.fn(async (fn: (s: unknown) => unknown) => {
  if (!pendingSession) throw new Error("test did not seed pendingSession");
  const s = pendingSession;
  pendingSession = null;
  return fn(s.session);
});

vi.mock("@/lib/neo4j", () => ({
  withReadSession: (fn: (s: unknown) => unknown) => withReadSessionMock(fn),
}));

const { GET: getPath } = await import(
  "../../src/app/api/v1/graph/path/[from]/[to]/route"
);

const PERSON_A = "67050b91-5011-4ba6-b230-9a387879717a";
const PERSON_B = "44444444-4444-4444-8444-444444444441";

function req(url: string): Request {
  return new Request(url);
}

function authed() {
  getAuthMock.mockResolvedValue({ userId: "user-1", selfNodeId: null });
}

function unauthed() {
  getAuthMock.mockResolvedValueOnce(null);
}

// ---------------------------------------------------------------------------
// /path/:from/:to — pure Cypher, no GDS dependency. The only graph-intel
// route that survived the 2026-04-20 tier-gating cleanup (community view +
// hub-centrality surfaces were dropped pending Aura Graph Analytics).
// ---------------------------------------------------------------------------

describe("GET /api/v1/graph/path/:from/:to", () => {
  beforeEach(() => {
    getAuthMock.mockReset();
    withReadSessionMock.mockClear();
    pendingSession = null;
    authed();
  });

  it("400 on non-uuid from", async () => {
    const res = await getPath(
      req(`http://localhost/api/v1/graph/path/bad/${PERSON_B}`),
      { params: Promise.resolve({ from: "bad", to: PERSON_B }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_ID");
  });

  it("400 on non-uuid to", async () => {
    const res = await getPath(
      req(`http://localhost/api/v1/graph/path/${PERSON_A}/bad`),
      { params: Promise.resolve({ from: PERSON_A, to: "bad" }) },
    );
    expect(res.status).toBe(400);
  });

  it("401 when not authenticated", async () => {
    unauthed();
    const res = await getPath(
      req(`http://localhost/api/v1/graph/path/${PERSON_A}/${PERSON_B}`),
      { params: Promise.resolve({ from: PERSON_A, to: PERSON_B }) },
    );
    expect(res.status).toBe(401);
  });

  it("404 when a person doesn't exist", async () => {
    pendingSession = makeSession([
      {
        match: /MATCH \(p:Person \{user_id: \$uid\}\)\s+WHERE p\.id IN/,
        respond: () => ({ records: [record({ id: PERSON_A })] }), // only A returned
      },
    ]);
    const res = await getPath(
      req(`http://localhost/api/v1/graph/path/${PERSON_A}/${PERSON_B}`),
      { params: Promise.resolve({ from: PERSON_A, to: PERSON_B }) },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("404 when no path exists", async () => {
    pendingSession = makeSession([
      {
        match: /WHERE p\.id IN/,
        respond: () => ({
          records: [record({ id: PERSON_A }), record({ id: PERSON_B })],
        }),
      },
      {
        match: /shortestPath/,
        respond: () => ({ records: [] }),
      },
    ]);
    const res = await getPath(
      req(`http://localhost/api/v1/graph/path/${PERSON_A}/${PERSON_B}`),
      { params: Promise.resolve({ from: PERSON_A, to: PERSON_B }) },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NO_PATH");
  });

  it("503 when Neo4j is unreachable", async () => {
    withReadSessionMock.mockRejectedValueOnce(
      Object.assign(new Error("bolt dead"), { code: "ServiceUnavailable" }),
    );
    const res = await getPath(
      req(`http://localhost/api/v1/graph/path/${PERSON_A}/${PERSON_B}`),
      { params: Promise.resolve({ from: PERSON_A, to: PERSON_B }) },
    );
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("NEO4J_UNREACHABLE");
  });

  it("200 shape on happy path", async () => {
    pendingSession = makeSession([
      {
        match: /WHERE p\.id IN/,
        respond: () => ({
          records: [record({ id: PERSON_A }), record({ id: PERSON_B })],
        }),
      },
      {
        match: /shortestPath/,
        respond: () => ({
          records: [
            record({
              pathNodes: [
                { id: PERSON_A, name: "Alice", category: "founder", company: "Acme" },
                { id: "aa000000-0000-0000-0000-000000000001", name: "Bridge", category: "other", company: null },
                { id: PERSON_B, name: "Bob", category: "fellow", company: null },
              ],
              hops: 2,
              edges: [
                { type: "DM", weight: 1.5 },
                { type: "DM", weight: 1.5 },
              ],
            }),
          ],
        }),
      },
    ]);
    const res = await getPath(
      req(`http://localhost/api/v1/graph/path/${PERSON_A}/${PERSON_B}`),
      { params: Promise.resolve({ from: PERSON_A, to: PERSON_B }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.path)).toBe(true);
    expect(body.path).toHaveLength(3);
    expect(body.path[0]).toEqual({
      id: PERSON_A,
      name: "Alice",
      category: "founder",
      company: "Acme",
    });
    expect(body.hops).toBe(2);
    expect(body.edge_types).toEqual(["DM", "DM"]);
    expect(body.total_affinity).toBeCloseTo(3.0, 5);
  });
});
