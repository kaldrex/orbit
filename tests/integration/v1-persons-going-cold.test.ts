import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// /api/v1/persons/going-cold — Neo4j-backed read route that filters the
// user's projected graph by the Going Cold criterion (last_interaction_at
// > 14 days ago AND score > 5), sorted oldest-first.
// ---------------------------------------------------------------------------

const getAuthMock = vi.fn();
const withReadSessionMock = vi.fn();

vi.mock("@/lib/api-auth", () => ({
  getAgentOrSessionAuth: getAuthMock,
}));

vi.mock("@/lib/neo4j", () => ({
  withReadSession: (fn: (s: unknown) => unknown) => withReadSessionMock(fn),
}));

const { GET } = await import(
  "../../src/app/api/v1/persons/going-cold/route"
);

function req(): Request {
  return new Request("http://localhost/api/v1/persons/going-cold");
}

function record(obj: Record<string, unknown>) {
  return { get: (k: string) => obj[k] };
}

function scriptedSession(records: Array<Record<string, unknown>>) {
  return {
    run: async () => ({ records: records.map(record) }),
  };
}

const TWENTY_DAYS_AGO = new Date(
  Date.now() - 20 * 24 * 60 * 60 * 1000,
).toISOString();
const SIXTY_DAYS_AGO = new Date(
  Date.now() - 60 * 24 * 60 * 60 * 1000,
).toISOString();

describe("GET /api/v1/persons/going-cold", () => {
  beforeEach(() => {
    getAuthMock.mockReset();
    withReadSessionMock.mockReset();
    getAuthMock.mockResolvedValue({ userId: "user-1", selfNodeId: null });
  });

  it("401 when not authenticated", async () => {
    getAuthMock.mockResolvedValueOnce(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns the expected shape: {persons, total}", async () => {
    withReadSessionMock.mockImplementationOnce(
      async (fn: (s: unknown) => unknown) =>
        fn(
          scriptedSession([
            {
              id: "p1",
              name: "Alice",
              category: "sponsor",
              last_touch: TWENTY_DAYS_AGO,
              score: 6.2,
            },
          ]),
        ),
    );
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.persons)).toBe(true);
    expect(body.total).toBe(1);
    expect(body.persons[0]).toMatchObject({
      id: "p1",
      name: "Alice",
      category: "sponsor",
      score: 6.2,
    });
    expect(typeof body.persons[0].days_since).toBe("number");
    expect(body.persons[0].days_since).toBeGreaterThanOrEqual(19);
    expect(body.persons[0].last_touch).toBe(TWENTY_DAYS_AGO);
  });

  it("empty case returns {persons: [], total: 0}", async () => {
    withReadSessionMock.mockImplementationOnce(
      async (fn: (s: unknown) => unknown) => fn(scriptedSession([])),
    );
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ persons: [], total: 0 });
  });

  it("preserves oldest-first order from the Cypher ORDER BY clause", async () => {
    // The route trusts Neo4j's ORDER BY p.last_interaction_at ASC — this
    // test pins the contract: whatever order records arrive in must be
    // preserved unchanged in the response persons[] array.
    withReadSessionMock.mockImplementationOnce(
      async (fn: (s: unknown) => unknown) =>
        fn(
          scriptedSession([
            {
              id: "older",
              name: "Older",
              category: "fellow",
              last_touch: SIXTY_DAYS_AGO,
              score: 7,
            },
            {
              id: "newer",
              name: "Newer",
              category: "sponsor",
              last_touch: TWENTY_DAYS_AGO,
              score: 6,
            },
          ]),
        ),
    );
    const res = await GET(req());
    const body = await res.json();
    expect(body.persons.map((p: { id: string }) => p.id)).toEqual([
      "older",
      "newer",
    ]);
    expect(body.persons[0].days_since).toBeGreaterThan(body.persons[1].days_since);
  });

  it("Neo4j error → 200 with empty payload + warning log (graceful)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    withReadSessionMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ persons: [], total: 0 });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
