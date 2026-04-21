import { describe, it, expect, vi, beforeEach } from "vitest";

// --- hoisted mocks ---
const getAuthMock = vi.fn();
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

vi.mock("@/lib/api-auth", () => ({
  getAgentOrSessionAuth: getAuthMock,
}));

// Programmable rpc stub
let rpcResponse: { data: unknown; error: unknown } | null = null;

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (rpcResponse) return rpcResponse;
      const n = (args.p_rows as unknown[]).length;
      return {
        data: [{
          inserted: n,
          deduped: 0,
          // Deterministic fake uuids, one per row, to mimic the RPC's
          // new inserted_ids[] return field from 20260421_single_source_merge.
          inserted_ids: Array.from(
            { length: n },
            (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`
          ),
        }],
        error: null,
      };
    },
  }),
}));

// Import AFTER mocks so the module picks them up
const { POST, GET } = await import("../../src/app/api/v1/observations/route");

function makeReq(body: unknown): Request {
  return new Request("http://localhost/api/v1/observations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validInteraction = {
  observed_at: "2026-04-19T12:00:00Z",
  observer: "wazowski",
  kind: "interaction",
  evidence_pointer: "wacli://messages/rowid=12345",
  confidence: 0.9,
  reasoning: "seen in WhatsApp DM thread with Umayr",
  payload: {
    participants: ["Sanchay", "Umayr"],
    channel: "whatsapp",
    summary: "jewelry AI scope",
    topic: "tech",
    relationship_context: "",
    connection_context: "",
    sentiment: "positive",
  },
};

describe("POST /api/v1/observations", () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    getAuthMock.mockReset();
    getAuthMock.mockResolvedValue({ userId: "user-1", selfNodeId: null });
  });

  it("accepts a valid batch and calls upsert_observations", async () => {
    const res = await POST(makeReq([validInteraction]));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.accepted).toBe(1);
    expect(body.inserted).toBe(1);
    expect(body.deduped).toBe(0);
    expect(body.inserted_ids).toHaveLength(1);
    expect(body.inserted_ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(rpcCalls[0].name).toBe("upsert_observations");
    expect(rpcCalls[0].args.p_user_id).toBe("user-1");
  });

  it("accepts a single-source merge (1 merged_observation_id)", async () => {
    // Canary for the 20260421_single_source_merge migration: the Zod
    // layer must now accept merged_observation_ids with length 1.
    const singleSourceMerge = {
      observed_at: "2026-04-19T12:00:00Z",
      observer: "wazowski",
      kind: "merge",
      evidence_pointer: "manual://dashboard/add-contact/merge/p1",
      confidence: 1.0,
      reasoning: "Single-source materialization from manual entry.",
      payload: {
        person_id: "00000000-0000-4000-8000-000000000aaa",
        merged_observation_ids: ["00000000-0000-4000-8000-000000000001"],
        deterministic_bridges: [],
      },
    };
    const res = await POST(makeReq([singleSourceMerge]));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.inserted).toBe(1);
    expect(body.inserted_ids).toHaveLength(1);
  });

  it("rejects zero-merged-ids merge at the Zod layer", async () => {
    const zeroMerge = {
      observed_at: "2026-04-19T12:00:00Z",
      observer: "wazowski",
      kind: "merge",
      evidence_pointer: "manual://dashboard/add-contact/merge/p2",
      confidence: 1.0,
      reasoning: "empty-ids merge should fail",
      payload: {
        person_id: "00000000-0000-4000-8000-000000000bbb",
        merged_observation_ids: [],
        deterministic_bridges: [],
      },
    };
    const res = await POST(makeReq([zeroMerge]));
    expect(res.status).toBe(400);
  });

  it("rejects an empty batch", async () => {
    const res = await POST(makeReq([]));
    expect(res.status).toBe(400);
  });

  it("rejects a batch > MAX_BATCH (100)", async () => {
    const big = Array.from({ length: 101 }, (_, i) => ({
      ...validInteraction,
      evidence_pointer: `wacli://messages/rowid=${i}`,
    }));
    const res = await POST(makeReq(big));
    expect(res.status).toBe(400);
  });

  it("returns 401 when not authenticated", async () => {
    getAuthMock.mockResolvedValueOnce(null);
    const res = await POST(makeReq([validInteraction]));
    expect(res.status).toBe(401);
  });

  it("returns 400 on invalid json", async () => {
    const res = await POST(
      new Request("http://localhost/api/v1/observations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      })
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 on invalid observation kind", async () => {
    const res = await POST(makeReq([{ ...validInteraction, kind: "dream" }]));
    expect(res.status).toBe(400);
  });

  it("returns 400 on out-of-range confidence", async () => {
    const res = await POST(makeReq([{ ...validInteraction, confidence: 1.5 }]));
    expect(res.status).toBe(400);
  });

  beforeEach(() => {
    rpcResponse = null;
  });

  it("accepts mixed-kind batch and passes through", async () => {
    const personObs = {
      observed_at: "2026-04-19T12:00:00Z",
      observer: "wazowski",
      kind: "person",
      evidence_pointer: "wacli://contacts/jid=X",
      confidence: 0.9,
      reasoning: "seen as contact",
      payload: {
        name: "Umayr",
        category: "team",
        relationship_to_me: "co-founder at SinX",
      },
    };
    const res = await POST(makeReq([validInteraction, personObs]));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accepted).toBe(2);
  });
});

describe("GET /api/v1/observations", () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    rpcResponse = null;
    getAuthMock.mockReset();
    getAuthMock.mockResolvedValue({ userId: "user-1", selfNodeId: null });
  });

  function getReq(qs = ""): Request {
    return new Request(`http://localhost/api/v1/observations${qs}`);
  }

  it("401 when not authenticated", async () => {
    getAuthMock.mockResolvedValueOnce(null);
    const res = await GET(getReq());
    expect(res.status).toBe(401);
  });

  it("returns observations array and calls select_observations", async () => {
    rpcResponse = {
      data: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          observed_at: "2026-04-19T12:00:00Z",
          kind: "interaction",
        },
      ],
      error: null,
    };
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.observations).toHaveLength(1);
    expect(rpcCalls[0].name).toBe("select_observations");
  });

  it("400 on invalid kind param", async () => {
    const res = await GET(getReq("?kind=dream"));
    expect(res.status).toBe(400);
  });

  it("400 on invalid since param", async () => {
    const res = await GET(getReq("?since=yesterday"));
    expect(res.status).toBe(400);
  });

  it("400 on invalid limit", async () => {
    const res = await GET(getReq("?limit=abc"));
    expect(res.status).toBe(400);
  });

  it("400 on malformed cursor", async () => {
    const res = await GET(getReq("?cursor=not-a-uuid"));
    expect(res.status).toBe(400);
  });

  it("sets next_cursor when result hits limit", async () => {
    const rows = Array.from({ length: 2 }, (_, i) => ({
      id: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${i}`,
      observed_at: "2026-04-19T12:00:00Z",
    }));
    rpcResponse = { data: rows, error: null };
    const res = await GET(getReq("?limit=2"));
    const body = await res.json();
    expect(body.next_cursor).toBe(rows[1].id);
  });

  it("null next_cursor when result below limit", async () => {
    rpcResponse = { data: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }], error: null };
    const res = await GET(getReq("?limit=100"));
    const body = await res.json();
    expect(body.next_cursor).toBeNull();
  });
});
