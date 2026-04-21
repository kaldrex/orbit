import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthMock = vi.fn();
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let rpcReturn: Array<Record<string, unknown>> = [];
let rpcError: { message: string } | null = null;

vi.mock("@/lib/api-auth", () => ({
  getAgentOrSessionAuth: getAuthMock,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (rpcError) return { data: null, error: rpcError };
      return { data: rpcReturn, error: null };
    },
  }),
}));

const { GET } = await import(
  "../../src/app/api/v1/persons/active-since/route"
);

function req(qs: string): Request {
  return new Request(`http://localhost/api/v1/persons/active-since${qs}`);
}

describe("GET /api/v1/persons/active-since", () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    getAuthMock.mockReset();
    getAuthMock.mockResolvedValue({ userId: "u1", selfNodeId: null });
    rpcReturn = [];
    rpcError = null;
  });

  it("401 unauthenticated", async () => {
    getAuthMock.mockResolvedValueOnce(null);
    const res = await GET(req("?since=2026-04-20T00:00:00Z"));
    expect(res.status).toBe(401);
  });

  it("400 missing since", async () => {
    const res = await GET(req(""));
    expect(res.status).toBe(400);
  });

  it("400 invalid since", async () => {
    const res = await GET(req("?since=not-a-date"));
    expect(res.status).toBe(400);
  });

  it("happy path returns {persons, total} and calls select_persons_active_since", async () => {
    rpcReturn = [
      {
        person_id: "11111111-1111-4111-8111-111111111111",
        last_activity_at: "2026-04-21T00:00:00Z",
        activity_count: 5,
      },
      {
        person_id: "22222222-2222-4222-8222-222222222222",
        last_activity_at: "2026-04-20T08:00:00Z",
        activity_count: 2,
      },
    ];
    const res = await GET(req("?since=2026-04-20T00:00:00Z"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.total).toBe(2);
    expect(json.persons).toHaveLength(2);
    expect(rpcCalls[0].name).toBe("select_persons_active_since");
    expect(rpcCalls[0].args.p_user_id).toBe("u1");
    expect(rpcCalls[0].args.p_needs_enrichment).toBe(false);
  });

  it("passes needs_enrichment=true when query param set", async () => {
    await GET(req("?since=2026-04-20T00:00:00Z&needs_enrichment=true"));
    expect(rpcCalls[0].args.p_needs_enrichment).toBe(true);
  });

  it("502 on RPC error", async () => {
    rpcError = { message: "db down" };
    const res = await GET(req("?since=2026-04-20T00:00:00Z"));
    expect(res.status).toBe(502);
  });
});
