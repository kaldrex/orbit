import { describe, it, expect, vi, beforeEach } from "vitest";

// --- hoisted mocks ---
const getAuthMock = vi.fn();
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

// Mutable per-test handler. Defaults to the POST upsert contract
// (returns {inserted: <rows length>, updated: 0}). GET tests
// override via rpcHandler = ... in their own beforeEach.
let rpcHandler: (
  name: string,
  args: Record<string, unknown>,
) => { data: unknown; error: unknown } = (_name, args) => ({
  data: [{ inserted: (args.p_rows as unknown[])?.length ?? 0, updated: 0 }],
  error: null,
});

vi.mock("@/lib/api-auth", () => ({
  getAgentOrSessionAuth: getAuthMock,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return rpcHandler(name, args);
    },
  }),
}));

// Import AFTER mocks so the module picks them up
const { POST, GET } = await import("../../src/app/api/v1/raw_events/route");

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

function getReq(qs = ""): Request {
  return new Request(`http://localhost/api/v1/raw_events${qs}`, {
    method: "GET",
  });
}

describe("GET /api/v1/raw_events", () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    getAuthMock.mockReset();
    getAuthMock.mockResolvedValue({ userId: "user-1", selfNodeId: null });
  });

  it("returns paginated events with next_cursor when page is full", async () => {
    // Fake select_raw_events: produce exactly `p_limit` rows so the
    // route computes a next_cursor.
    rpcHandler = (name, args) => {
      expect(name).toBe("select_raw_events");
      const limit = args.p_limit as number;
      const rows = Array.from({ length: limit }, (_, i) => ({
        id: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa${String(i).padStart(2, "0")}`,
        user_id: "user-1",
        source: "whatsapp",
        source_event_id: `wa_${i}`,
        channel: "whatsapp",
        occurred_at: "2026-04-18T12:00:00.000Z",
      }));
      return { data: rows, error: null };
    };
    const res = await GET(getReq("?source=whatsapp&limit=5"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(5);
    expect(body.next_cursor).toMatch(/^\d{4}-\d{2}-\d{2}T/); // "iso|uuid"
    expect(body.next_cursor).toContain("|");
    expect(rpcCalls[0].name).toBe("select_raw_events");
    expect(rpcCalls[0].args.p_source).toBe("whatsapp");
    expect(rpcCalls[0].args.p_limit).toBe(5);
  });

  it("returns null next_cursor on a partial last page", async () => {
    rpcHandler = () => ({
      data: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
          user_id: "user-1",
          source: "whatsapp",
          source_event_id: "wa_a",
          channel: "whatsapp",
          occurred_at: "2026-04-18T12:00:00.000Z",
        },
      ],
      error: null,
    });
    const res = await GET(getReq("?limit=10"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    expect(body.next_cursor).toBeNull();
  });

  it("rejects an invalid source", async () => {
    const res = await GET(getReq("?source=bogus"));
    expect(res.status).toBe(400);
  });

  it("rejects an invalid cursor (no pipe)", async () => {
    const res = await GET(getReq("?cursor=not-a-cursor"));
    expect(res.status).toBe(400);
  });

  it("rejects an invalid cursor id", async () => {
    const res = await GET(
      getReq("?cursor=2026-04-18T12:00:00.000Z|not-a-uuid"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 401 when not authenticated", async () => {
    getAuthMock.mockResolvedValueOnce(null);
    const res = await GET(getReq());
    expect(res.status).toBe(401);
  });
});
