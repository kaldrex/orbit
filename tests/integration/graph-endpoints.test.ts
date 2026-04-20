import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthMock = vi.fn();

vi.mock("@/lib/api-auth", () => ({
  getAgentOrSessionAuth: getAuthMock,
}));

const { GET: getNeighbors } = await import(
  "../../src/app/api/v1/graph/neighbors/[id]/route"
);
const { GET: getPath } = await import(
  "../../src/app/api/v1/graph/path/[from]/[to]/route"
);
const { GET: getCommunities } = await import(
  "../../src/app/api/v1/graph/communities/route"
);
const { GET: getCentrality } = await import(
  "../../src/app/api/v1/graph/centrality/route"
);
const { POST: postPopulate } = await import(
  "../../src/app/api/v1/graph/populate/route"
);

const PERSON_A = "67050b91-5011-4ba6-b230-9a387879717a";
const PERSON_B = "44444444-4444-4444-8444-444444444441";

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

describe("GET /api/v1/graph/path/:from/:to", () => {
  beforeEach(() => {
    getAuthMock.mockReset();
    authed();
  });

  it("400 on non-uuid from", async () => {
    const res = await getPath(
      req(`http://localhost/api/v1/graph/path/bad/${PERSON_B}`),
      { params: Promise.resolve({ from: "bad", to: PERSON_B }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_ID");
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

  it("503 NEO4J_NOT_POPULATED when authed", async () => {
    const res = await getPath(
      req(`http://localhost/api/v1/graph/path/${PERSON_A}/${PERSON_B}`),
      { params: Promise.resolve({ from: PERSON_A, to: PERSON_B }) },
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("NEO4J_NOT_POPULATED");
  });
});

describe("GET /api/v1/graph/communities", () => {
  beforeEach(() => {
    getAuthMock.mockReset();
    authed();
  });

  it("401 when not authenticated", async () => {
    unauthed();
    const res = await getCommunities(
      req("http://localhost/api/v1/graph/communities"),
    );
    expect(res.status).toBe(401);
  });

  it("503 NEO4J_NOT_POPULATED when authed", async () => {
    const res = await getCommunities(
      req("http://localhost/api/v1/graph/communities"),
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("NEO4J_NOT_POPULATED");
  });
});

describe("GET /api/v1/graph/centrality", () => {
  beforeEach(() => {
    getAuthMock.mockReset();
    authed();
  });

  it("401 when not authenticated", async () => {
    unauthed();
    const res = await getCentrality(
      req("http://localhost/api/v1/graph/centrality"),
    );
    expect(res.status).toBe(401);
  });

  it("503 NEO4J_NOT_POPULATED when authed", async () => {
    const res = await getCentrality(
      req("http://localhost/api/v1/graph/centrality"),
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("NEO4J_NOT_POPULATED");
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

  it("501 NOT_IMPLEMENTED when authed", async () => {
    const res = await postPopulate(
      req("http://localhost/api/v1/graph/populate", { method: "POST" }),
    );
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_IMPLEMENTED");
    expect(typeof body.error.message).toBe("string");
  });
});
