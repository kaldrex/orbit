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
        data: [{ inserted: (args.p_rows as unknown[]).length, updated: 0 }],
        error: null,
      };
    },
  }),
}));

// Import AFTER mocks so the module picks them up
const { POST } = await import("../../src/app/api/v1/raw_events/route");

function makeReq(body: unknown): Request {
  return new Request("http://localhost/api/v1/raw_events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/raw_events", () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    getAuthMock.mockReset();
    getAuthMock.mockResolvedValue({ userId: "user-1", selfNodeId: null });
  });

  it("accepts a valid batch and calls upsert_raw_events", async () => {
    const res = await POST(
      makeReq([
        {
          source: "whatsapp",
          source_event_id: "wa_1",
          channel: "whatsapp",
          occurred_at: "2026-04-18T12:00:00Z",
        },
      ])
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accepted).toBe(1);
    expect(rpcCalls[0].name).toBe("upsert_raw_events");
    expect(rpcCalls[0].args.p_user_id).toBe("user-1");
  });

  it("rejects an empty batch", async () => {
    const res = await POST(makeReq([]));
    expect(res.status).toBe(400);
  });

  it("rejects a batch > 500", async () => {
    const big = Array.from({ length: 501 }, (_, i) => ({
      source: "whatsapp" as const,
      source_event_id: `wa_${i}`,
      channel: "whatsapp",
      occurred_at: "2026-04-18T12:00:00Z",
    }));
    const res = await POST(makeReq(big));
    expect(res.status).toBe(400);
  });

  it("returns 401 when not authenticated", async () => {
    getAuthMock.mockResolvedValueOnce(null);
    const res = await POST(
      makeReq([
        {
          source: "whatsapp",
          source_event_id: "wa_x",
          channel: "whatsapp",
          occurred_at: "2026-04-18T12:00:00Z",
        },
      ])
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 on invalid json", async () => {
    const res = await POST(
      new Request("http://localhost/api/v1/raw_events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      })
    );
    expect(res.status).toBe(400);
  });
});
