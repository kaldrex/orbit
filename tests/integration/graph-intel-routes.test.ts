import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Shared mocks. Each route runs inside `withReadSession(fn)`; we fake that
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
const { GET: getCommunities } = await import(
  "../../src/app/api/v1/graph/communities/route"
);
const { GET: getCentrality } = await import(
  "../../src/app/api/v1/graph/centrality/route"
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
// /path/:from/:to
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
        match: /gds\.graph\.project/,
        respond: () => ({
          records: [
            record({ graphName: "g", nodes: 10, edges: 5 }),
          ],
        }),
      },
      {
        match: /gds\.shortestPath\.dijkstra\.stream/,
        respond: () => ({ records: [] }),
      },
      {
        match: /gds\.graph\.drop/,
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

  // /path uses pure Cypher `shortestPath()` — no GDS dependency, so
  // GDS_MISSING no longer applies to this route (only to /communities
  // and /centrality). Kept as a documentation anchor for the refactor.
  it.skip("GDS_MISSING — no longer applicable to /path (pure Cypher)", () => {});

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

// ---------------------------------------------------------------------------
// /communities
// ---------------------------------------------------------------------------

describe("GET /api/v1/graph/communities", () => {
  beforeEach(() => {
    getAuthMock.mockReset();
    withReadSessionMock.mockClear();
    pendingSession = null;
    authed();
  });

  it("401 when not authenticated", async () => {
    unauthed();
    const res = await getCommunities(
      req("http://localhost/api/v1/graph/communities"),
    );
    expect(res.status).toBe(401);
  });

  it("503 when Neo4j is unreachable", async () => {
    withReadSessionMock.mockRejectedValueOnce(
      Object.assign(new Error("dead"), { code: "ServiceUnavailable" }),
    );
    const res = await getCommunities(
      req("http://localhost/api/v1/graph/communities"),
    );
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("NEO4J_UNREACHABLE");
  });

  it("501 when GDS is missing", async () => {
    withReadSessionMock.mockRejectedValueOnce(
      new Error("Unable to authenticate without explicit Aura API credentials."),
    );
    const res = await getCommunities(
      req("http://localhost/api/v1/graph/communities"),
    );
    expect(res.status).toBe(501);
    expect((await res.json()).error.code).toBe("GDS_MISSING");
  });

  it("200 with empty array when graph has no edges", async () => {
    pendingSession = makeSession([
      {
        match: /gds\.graph\.project/,
        respond: () => ({
          records: [
            record({ graphName: "g", nodes: 1, edges: 0 }),
          ],
        }),
      },
      {
        match: /gds\.graph\.drop/,
        respond: () => ({ records: [] }),
      },
    ]);
    const res = await getCommunities(
      req("http://localhost/api/v1/graph/communities"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ communities: [] });
  });

  it("200 with communities on happy path", async () => {
    pendingSession = makeSession([
      {
        match: /gds\.graph\.project/,
        respond: () => ({
          records: [
            record({ graphName: "g", nodes: 10, edges: 20 }),
          ],
        }),
      },
      {
        match: /gds\.leiden\.stream/,
        respond: () => ({
          records: [
            record({
              id: 42,
              sz: 3,
              members: [
                { id: "p1", name: "Alice" },
                { id: "p2", name: "Bob" },
                { id: "p3", name: "Carol" },
              ],
            }),
            record({
              id: 7,
              sz: 2,
              members: [
                { id: "p4", name: "Dave" },
                { id: "p5", name: null },
              ],
            }),
          ],
        }),
      },
      {
        match: /gds\.graph\.drop/,
        respond: () => ({ records: [] }),
      },
    ]);
    const res = await getCommunities(
      req("http://localhost/api/v1/graph/communities"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.communities).toHaveLength(2);
    expect(body.communities[0]).toMatchObject({
      id: 42,
      size: 3,
      member_ids: ["p1", "p2", "p3"],
    });
    expect(body.communities[0].top_names).toEqual(["Alice", "Bob", "Carol"]);
    expect(body.communities[1].id).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// /centrality
// ---------------------------------------------------------------------------

describe("GET /api/v1/graph/centrality", () => {
  beforeEach(() => {
    getAuthMock.mockReset();
    withReadSessionMock.mockClear();
    pendingSession = null;
    authed();
  });

  it("401 when not authenticated", async () => {
    unauthed();
    const res = await getCentrality(
      req("http://localhost/api/v1/graph/centrality"),
    );
    expect(res.status).toBe(401);
  });

  it("503 when Neo4j is unreachable", async () => {
    withReadSessionMock.mockRejectedValueOnce(
      Object.assign(new Error("dead"), { code: "ServiceUnavailable" }),
    );
    const res = await getCentrality(
      req("http://localhost/api/v1/graph/centrality"),
    );
    expect(res.status).toBe(503);
  });

  it("501 when GDS is missing", async () => {
    withReadSessionMock.mockRejectedValueOnce(
      new Error("There is no procedure with the name `gds.betweenness.stream`"),
    );
    const res = await getCentrality(
      req("http://localhost/api/v1/graph/centrality"),
    );
    expect(res.status).toBe(501);
  });

  it("200 with nodes on happy path (shape snapshot)", async () => {
    pendingSession = makeSession([
      {
        match: /gds\.graph\.project/,
        respond: () => ({
          records: [
            record({ graphName: "g", nodes: 5, edges: 6 }),
          ],
        }),
      },
      {
        match: /gds\.betweenness\.stream/,
        respond: () => ({
          records: [
            record({
              id: "p-sanchay",
              name: "Sanchay",
              category: "founder",
              betweenness: 42.0,
              degree: 12,
            }),
            record({
              id: "p-bridge",
              name: "Bridge Node",
              category: "fellow",
              betweenness: 8.5,
              degree: 4,
            }),
          ],
        }),
      },
      {
        match: /gds\.graph\.drop/,
        respond: () => ({ records: [] }),
      },
    ]);
    const res = await getCentrality(
      req("http://localhost/api/v1/graph/centrality"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodes).toHaveLength(2);
    expect(body.nodes[0]).toMatchObject({
      id: "p-sanchay",
      name: "Sanchay",
      category: "founder",
      betweenness: 42,
      degree: 12,
    });
    // Sorted by betweenness desc.
    expect(body.nodes[0].betweenness).toBeGreaterThan(body.nodes[1].betweenness);
  });

  it("200 empty when graph has no edges", async () => {
    pendingSession = makeSession([
      {
        match: /gds\.graph\.project/,
        respond: () => ({
          records: [
            record({ graphName: "g", nodes: 1, edges: 0 }),
          ],
        }),
      },
      {
        match: /gds\.graph\.drop/,
        respond: () => ({ records: [] }),
      },
    ]);
    const res = await getCentrality(
      req("http://localhost/api/v1/graph/centrality"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ nodes: [] });
  });
});
