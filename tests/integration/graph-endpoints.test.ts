import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthMock = vi.fn();
const withReadSessionMock = vi.fn();

vi.mock("@/lib/api-auth", () => ({
  getAgentOrSessionAuth: getAuthMock,
}));

vi.mock("@/lib/neo4j", () => ({
  withReadSession: (fn: (session: unknown) => unknown) =>
    withReadSessionMock(fn),
}));

const { GET: getGraph } = await import("../../src/app/api/v1/graph/route");
const { GET: getNeighbors } = await import(
  "../../src/app/api/v1/graph/neighbors/[id]/route"
);
const { POST: postPopulate } = await import(
  "../../src/app/api/v1/graph/populate/route"
);

const PERSON_A = "67050b91-5011-4ba6-b230-9a387879717a";

function req(url: string, init?: RequestInit): Request {
  return new Request(url, init);
}

function authed() {
  getAuthMock.mockResolvedValue({ userId: "user-1", selfNodeId: null });
}

function unauthed() {
  getAuthMock.mockResolvedValueOnce(null);
}

describe("GET /api/v1/graph/neighbors/:id", () => {
  beforeEach(() => {
    getAuthMock.mockReset();
    authed();
  });

  it("400 on non-uuid id", async () => {
    const res = await getNeighbors(
      req("http://localhost/api/v1/graph/neighbors/not-uuid"),
      { params: Promise.resolve({ id: "not-uuid" }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_ID");
  });

  it("401 when not authenticated", async () => {
    unauthed();
    const res = await getNeighbors(
      req(`http://localhost/api/v1/graph/neighbors/${PERSON_A}`),
      { params: Promise.resolve({ id: PERSON_A }) },
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("503 NEO4J_NOT_POPULATED when authed", async () => {
    const res = await getNeighbors(
      req(`http://localhost/api/v1/graph/neighbors/${PERSON_A}`),
      { params: Promise.resolve({ id: PERSON_A }) },
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("NEO4J_NOT_POPULATED");
    expect(typeof body.error.message).toBe("string");
  });
});

describe("GET /api/v1/graph", () => {
  beforeEach(() => {
    getAuthMock.mockReset();
    withReadSessionMock.mockReset();
    authed();
  });

  it("401 when not authenticated", async () => {
    unauthed();
    const res = await getGraph(req("http://localhost/api/v1/graph"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns nodes/links/stats shape when Neo4j has data", async () => {
    withReadSessionMock.mockResolvedValueOnce({
      nodes: [
        {
          id: "p1",
          name: "Alice",
          score: 7,
          category: "sponsor",
          company: "Acme",
          lastInteractionAt: "2026-04-01T00:00:00Z",
        },
      ],
      links: [
        { source: "p1", target: "p2", weight: 1.5, type: "SHARED_GROUP" },
      ],
      stats: { totalPeople: 2, goingCold: 1 },
    });

    const res = await getGraph(req("http://localhost/api/v1/graph"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(Array.isArray(body.links)).toBe(true);
    expect(body.nodes).toHaveLength(1);
    expect(body.links).toHaveLength(1);
    expect(body.stats).toEqual({ totalPeople: 2, goingCold: 1 });
  });

  it("empty-graph case returns 200 with empty arrays and zero stats", async () => {
    withReadSessionMock.mockResolvedValueOnce({
      nodes: [],
      links: [],
      stats: { totalPeople: 0, goingCold: 0 },
    });

    const res = await getGraph(req("http://localhost/api/v1/graph"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      nodes: [],
      links: [],
      stats: { totalPeople: 0, goingCold: 0 },
    });
  });

  it("Neo4j error → 200 with empty payload + warning log (graceful)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    withReadSessionMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const res = await getGraph(req("http://localhost/api/v1/graph"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      nodes: [],
      links: [],
      stats: { totalPeople: 0, goingCold: 0 },
    });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("POST /api/v1/graph/populate", () => {
  beforeEach(() => {
    getAuthMock.mockReset();
    authed();
  });

  it("401 when not authenticated", async () => {
    unauthed();
    const res = await postPopulate(
      req("http://localhost/api/v1/graph/populate", { method: "POST" }),
    );
    expect(res.status).toBe(401);
  });

  // Real 2xx behaviour is covered in the dedicated populate-route test
  // file (graph-populate-route.test.ts), which mocks supabase + neo4j.
  // This file only guards the shared auth contract.
});
