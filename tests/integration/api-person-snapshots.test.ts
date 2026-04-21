import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthMock = vi.fn();
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let upsertReturn: string | null = null;
let selectReturn: Array<Record<string, unknown>> = [];
let rpcError: { message: string } | null = null;

vi.mock("@/lib/api-auth", () => ({
  getAgentOrSessionAuth: getAuthMock,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (rpcError) return { data: null, error: rpcError };
      if (name === "upsert_person_snapshot") {
        return { data: upsertReturn, error: null };
      }
      if (name === "select_person_snapshots") {
        return { data: selectReturn, error: null };
      }
      return { data: null, error: null };
    },
  }),
}));

const { POST, GET } = await import(
  "../../src/app/api/v1/person/[id]/snapshots/route"
);

const personId = "11111111-1111-4111-8111-111111111111";
const snapshotId = "22222222-2222-4222-8222-222222222222";

function postReq(body: unknown, id = personId): Request {
  return new Request(`http://localhost/api/v1/person/${id}/snapshots`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function getReq(id = personId, qs = ""): Request {
  return new Request(`http://localhost/api/v1/person/${id}/snapshots${qs}`);
}

describe("POST /api/v1/person/:id/snapshots", () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    getAuthMock.mockReset();
    getAuthMock.mockResolvedValue({ userId: "user-1", selfNodeId: null });
    upsertReturn = snapshotId;
    rpcError = null;
  });

  it("401 when not authenticated", async () => {
    getAuthMock.mockResolvedValueOnce(null);
    const res = await POST(
      postReq({ pass_kind: "enricher" }),
      { params: Promise.resolve({ id: personId }) },
    );
    expect(res.status).toBe(401);
  });

  it("400 on non-uuid id", async () => {
    const res = await POST(postReq({ pass_kind: "enricher" }, "not-a-uuid"), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
  });

  it("400 on invalid json", async () => {
    const req = new Request(`http://localhost/api/v1/person/${personId}/snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json{",
    });
    const res = await POST(req, { params: Promise.resolve({ id: personId }) });
    expect(res.status).toBe(400);
  });

  it("400 when pass_kind is missing or invalid", async () => {
    const r1 = await POST(postReq({}), { params: Promise.resolve({ id: personId }) });
    expect(r1.status).toBe(400);
    const r2 = await POST(postReq({ pass_kind: "bogus" }), {
      params: Promise.resolve({ id: personId }),
    });
    expect(r2.status).toBe(400);
  });

  it("happy path writes via upsert_person_snapshot and returns {ok, id}", async () => {
    const body = {
      pass_kind: "enricher",
      card_state: { category: "team", relationship_to_me: "co-lead" },
      evidence_pointer_ids: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      diff_summary: "picked up new title signal from this pass",
      confidence_delta: { category: 0.2 },
    };
    const res = await POST(postReq(body), { params: Promise.resolve({ id: personId }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.id).toBe(snapshotId);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].name).toBe("upsert_person_snapshot");
    expect(rpcCalls[0].args.p_user_id).toBe("user-1");
    expect(rpcCalls[0].args.p_person_id).toBe(personId);
    expect(rpcCalls[0].args.p_pass_kind).toBe("enricher");
  });

  it("defaults card_state, evidence_pointer_ids, diff_summary, confidence_delta when omitted", async () => {
    await POST(postReq({ pass_kind: "correction" }), {
      params: Promise.resolve({ id: personId }),
    });
    expect(rpcCalls[0].args.p_card_state).toEqual({});
    expect(rpcCalls[0].args.p_evidence_pointer_ids).toEqual([]);
    expect(rpcCalls[0].args.p_diff_summary).toBe("");
    expect(rpcCalls[0].args.p_confidence_delta).toEqual({});
  });

  it("404 when RPC reports cross-tenant person", async () => {
    rpcError = { message: "upsert_person_snapshot: person_id belongs to a different user" };
    const res = await POST(postReq({ pass_kind: "enricher" }), {
      params: Promise.resolve({ id: personId }),
    });
    expect(res.status).toBe(404);
  });

  it("404 when person_id is unknown", async () => {
    rpcError = { message: "upsert_person_snapshot: person_id not found" };
    const res = await POST(postReq({ pass_kind: "enricher" }), {
      params: Promise.resolve({ id: personId }),
    });
    expect(res.status).toBe(404);
  });

  it("502 on unexpected RPC errors", async () => {
    rpcError = { message: "db down" };
    const res = await POST(postReq({ pass_kind: "enricher" }), {
      params: Promise.resolve({ id: personId }),
    });
    expect(res.status).toBe(502);
  });
});

describe("GET /api/v1/person/:id/snapshots", () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    getAuthMock.mockReset();
    getAuthMock.mockResolvedValue({ userId: "user-1", selfNodeId: null });
    selectReturn = [];
    rpcError = null;
  });

  it("401 when not authenticated", async () => {
    getAuthMock.mockResolvedValueOnce(null);
    const res = await GET(getReq(), { params: Promise.resolve({ id: personId }) });
    expect(res.status).toBe(401);
  });

  it("400 on non-uuid id", async () => {
    const res = await GET(getReq("not-a-uuid"), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
  });

  it("400 on invalid limit", async () => {
    const res = await GET(getReq(personId, "?limit=-5"), {
      params: Promise.resolve({ id: personId }),
    });
    expect(res.status).toBe(400);
  });

  it("happy path returns {snapshots, total}", async () => {
    selectReturn = [
      {
        id: snapshotId,
        person_id: personId,
        pass_at: "2026-04-22T00:00:00Z",
        pass_kind: "enricher",
        card_state: { category: "team" },
        evidence_pointer_ids: [],
        diff_summary: "first pass",
        confidence_delta: {},
        created_at: "2026-04-22T00:00:00Z",
      },
    ];
    const res = await GET(getReq(), { params: Promise.resolve({ id: personId }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.total).toBe(1);
    expect(json.snapshots).toHaveLength(1);
    expect(json.snapshots[0].pass_kind).toBe("enricher");
    expect(rpcCalls[0].name).toBe("select_person_snapshots");
    expect(rpcCalls[0].args.p_limit).toBe(50);
  });

  it("respects ?limit up to the 200 cap", async () => {
    await GET(getReq(personId, "?limit=500"), {
      params: Promise.resolve({ id: personId }),
    });
    expect(rpcCalls[0].args.p_limit).toBe(200);
  });

  it("502 on RPC error", async () => {
    rpcError = { message: "db down" };
    const res = await GET(getReq(), { params: Promise.resolve({ id: personId }) });
    expect(res.status).toBe(502);
  });
});
