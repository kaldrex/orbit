import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthMock = vi.fn();
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let rpcRows: unknown[] = [];
let rpcError: unknown = null;

vi.mock("@/lib/api-auth", () => ({
  getAgentOrSessionAuth: getAuthMock,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return { data: rpcRows, error: rpcError };
    },
  }),
}));

const { GET } = await import("../../src/app/api/v1/persons/search/route");

function req(qs: string): Request {
  return new Request(`http://localhost/api/v1/persons/search${qs}`);
}

describe("GET /api/v1/persons/search", () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    getAuthMock.mockReset();
    getAuthMock.mockResolvedValue({ userId: "user-1", selfNodeId: null });
    rpcRows = [];
    rpcError = null;
  });

  it("401 when not authenticated", async () => {
    getAuthMock.mockResolvedValueOnce(null);
    const res = await GET(req("?email=keith@example.com"));
    expect(res.status).toBe(401);
  });

  it("400 when no search param provided", async () => {
    const res = await GET(req(""));
    expect(res.status).toBe(400);
  });

  it("400 when multiple search params provided", async () => {
    const res = await GET(req("?email=a@example.com&phone=%2B14155551234"));
    expect(res.status).toBe(400);
  });

  it("400 on invalid limit", async () => {
    const res = await GET(req("?name=Keith&limit=0"));
    expect(res.status).toBe(400);
  });

  it("searches by phone", async () => {
    rpcRows = [{ id: "p1", phones: ["+14155551234"] }];
    const res = await GET(req("?phone=%2B14155551234"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.total).toBe(1);
    expect(rpcCalls[0].name).toBe("search_persons");
    expect(rpcCalls[0].args.p_phone).toBe("+14155551234");
    expect(rpcCalls[0].args.p_email).toBeNull();
    expect(rpcCalls[0].args.p_limit).toBe(10);
  });

  it("searches by lowercase email and clamps limit", async () => {
    await GET(req("?email=Keith@Example.com&limit=500"));
    expect(rpcCalls[0].args.p_email).toBe("keith@example.com");
    expect(rpcCalls[0].args.p_limit).toBe(50);
  });

  it("searches by name", async () => {
    await GET(req("?name=Keith&limit=5"));
    expect(rpcCalls[0].args.p_name).toBe("Keith");
    expect(rpcCalls[0].args.p_limit).toBe(5);
  });

  it("502 on RPC error", async () => {
    rpcError = { message: "boom" };
    const res = await GET(req("?name=Keith"));
    expect(res.status).toBe(502);
  });
});
