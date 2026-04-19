import { describe, it, expect, vi, beforeEach } from "vitest";

// --- hoisted mocks ---
const getAuthMock = vi.fn();
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

vi.mock("@/lib/api-auth", () => ({
  getAgentOrSessionAuth: getAuthMock,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return {
        data: [{ inserted: (args.p_rows as unknown[]).length, deduped: 0 }],
        error: null,
      };
    },
  }),
}));

// Import AFTER mocks so the module picks them up
const { POST } = await import("../../src/app/api/v1/observations/route");

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
    expect(rpcCalls[0].name).toBe("upsert_observations");
    expect(rpcCalls[0].args.p_user_id).toBe("user-1");
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
