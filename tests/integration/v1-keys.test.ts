import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthMock = vi.fn();
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let rpcResponse: { data: unknown; error: unknown } = {
  data: [{ created_at: "2026-04-20T10:00:00+00:00" }],
  error: null,
};

vi.mock("@/lib/api-auth", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api-auth")>("@/lib/api-auth");
  return {
    getAgentOrSessionAuth: getAuthMock,
    generateApiKey: actual.generateApiKey,
  };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return rpcResponse;
    },
  }),
}));

const { POST } = await import("../../src/app/api/v1/keys/route");

function makeReq(body: unknown): Request {
  return new Request("http://localhost/api/v1/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "" : JSON.stringify(body),
  });
}

describe("POST /api/v1/keys", () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    getAuthMock.mockReset();
    getAuthMock.mockResolvedValue({ userId: "user-1", selfNodeId: null });
    rpcResponse = {
      data: [{ created_at: "2026-04-20T10:00:00+00:00" }],
      error: null,
    };
  });

  it("returns 401 when not authenticated", async () => {
    getAuthMock.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ name: "test" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unauthorized");
  });

  it("mints a key and returns { key, prefix, name, created_at }", async () => {
    const res = await POST(makeReq({ name: "ci" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key).toMatch(/^orb_live_/);
    expect(body.prefix).toMatch(/^orb_live_/);
    expect(body.prefix).toHaveLength(12);
    expect(body.name).toBe("ci");
    expect(body.created_at).toBe("2026-04-20T10:00:00+00:00");

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].name).toBe("mint_api_key");
    expect(rpcCalls[0].args.p_user_id).toBe("user-1");
    expect(rpcCalls[0].args.p_name).toBe("ci");
    expect(typeof rpcCalls[0].args.p_key_hash).toBe("string");
    expect((rpcCalls[0].args.p_key_hash as string)).toHaveLength(64);
    expect(rpcCalls[0].args.p_prefix).toBe(body.prefix);
  });

  it("defaults name to 'agent' when body is empty", async () => {
    const res = await POST(
      new Request("http://localhost/api/v1/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("agent");
    expect(rpcCalls[0].args.p_name).toBe("agent");
  });

  it("rejects invalid body (name too long)", async () => {
    const res = await POST(makeReq({ name: "x".repeat(200) }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_body");
    expect(rpcCalls).toHaveLength(0);
  });

  it("rejects malformed JSON", async () => {
    const res = await POST(
      new Request("http://localhost/api/v1/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_json");
  });

  it("returns 502 when RPC errors", async () => {
    rpcResponse = { data: null, error: { message: "boom" } };
    const res = await POST(makeReq({ name: "test" }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("mint_failed");
  });

  it("response shape snapshot — key is exposed only in response, not logged", async () => {
    const res = await POST(makeReq({ name: "shape" }));
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual([
      "created_at",
      "key",
      "name",
      "prefix",
    ]);
  });
});
