import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthMock = vi.fn();
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

let selectRpcResponse: { data: unknown; error: unknown } = { data: [], error: null };
let upsertRpcResponse: { data: unknown; error: unknown } = {
  data: "2026-04-20T10:05:00+00:00",
  error: null,
};

vi.mock("@/lib/api-auth", () => ({
  getAgentOrSessionAuth: getAuthMock,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === "select_capability_reports") return selectRpcResponse;
      if (name === "upsert_capability_report") return upsertRpcResponse;
      return { data: null, error: { message: `unexpected rpc: ${name}` } };
    },
  }),
}));

const { GET, POST } = await import(
  "../../src/app/api/v1/capabilities/route"
);

describe("GET /api/v1/capabilities", () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    getAuthMock.mockReset();
    getAuthMock.mockResolvedValue({ userId: "user-1", selfNodeId: null });
    selectRpcResponse = { data: [], error: null };
  });

  it("returns 401 when not authenticated", async () => {
    getAuthMock.mockResolvedValueOnce(null);
    const res = await GET(
      new Request("http://localhost/api/v1/capabilities"),
    );
    expect(res.status).toBe(401);
  });

  it("returns empty agents list when no reports", async () => {
    selectRpcResponse = { data: [], error: null };
    const res = await GET(
      new Request("http://localhost/api/v1/capabilities"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agents).toEqual([]);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].name).toBe("select_capability_reports");
    expect(rpcCalls[0].args.p_user_id).toBe("user-1");
  });

  it("maps RPC rows to the onboarding UI shape", async () => {
    selectRpcResponse = {
      data: [
        {
          agent_id: "wazowski",
          hostname: "wazowski.local",
          channels: { whatsapp: true, slack: false },
          data_sources: { gmail: true, calendar: false },
          tools: { merge_v2: true },
          reported_at: "2026-04-20T09:00:00+00:00",
        },
      ],
      error: null,
    };
    const res = await GET(
      new Request("http://localhost/api/v1/capabilities"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agents).toHaveLength(1);
    const a = body.agents[0];
    expect(a.agentId).toBe("wazowski");
    expect(a.hostname).toBe("wazowski.local");
    expect(a.channels).toEqual({ whatsapp: true, slack: false });
    expect(a.dataSources).toEqual({ gmail: true, calendar: false });
    expect(a.tools).toEqual({ merge_v2: true });
    expect(a.reportedAt).toBe("2026-04-20T09:00:00+00:00");
  });

  it("returns 502 when the RPC errors", async () => {
    selectRpcResponse = { data: null, error: { message: "db down" } };
    const res = await GET(
      new Request("http://localhost/api/v1/capabilities"),
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("read_failed");
  });
});

describe("POST /api/v1/capabilities", () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    getAuthMock.mockReset();
    getAuthMock.mockResolvedValue({ userId: "user-1", selfNodeId: null });
    upsertRpcResponse = {
      data: "2026-04-20T10:05:00+00:00",
      error: null,
    };
  });

  function makeReq(body: unknown): Request {
    return new Request("http://localhost/api/v1/capabilities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("returns 401 when not authenticated", async () => {
    getAuthMock.mockResolvedValueOnce(null);
    const res = await POST(
      makeReq({
        agent_id: "a",
        channels: {},
        data_sources: {},
        tools: {},
      }),
    );
    expect(res.status).toBe(401);
  });

  it("upserts a valid report and returns { ok, reported_at }", async () => {
    const res = await POST(
      makeReq({
        agent_id: "wazowski",
        hostname: "wazowski.local",
        channels: { whatsapp: true },
        data_sources: { gmail: true },
        tools: { merge_v2: true },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.reported_at).toBe("2026-04-20T10:05:00+00:00");

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].name).toBe("upsert_capability_report");
    expect(rpcCalls[0].args.p_user_id).toBe("user-1");
    expect(rpcCalls[0].args.p_agent_id).toBe("wazowski");
    expect(rpcCalls[0].args.p_hostname).toBe("wazowski.local");
    expect(rpcCalls[0].args.p_channels).toEqual({ whatsapp: true });
    expect(rpcCalls[0].args.p_data_sources).toEqual({ gmail: true });
    expect(rpcCalls[0].args.p_tools).toEqual({ merge_v2: true });
  });

  it("rejects body missing required fields", async () => {
    const res = await POST(makeReq({ agent_id: "x" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_body");
    expect(rpcCalls).toHaveLength(0);
  });

  it("rejects malformed JSON", async () => {
    const res = await POST(makeReq("{not-json"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_json");
  });

  it("returns 502 when RPC errors", async () => {
    upsertRpcResponse = { data: null, error: { message: "boom" } };
    const res = await POST(
      makeReq({
        agent_id: "wazowski",
        channels: {},
        data_sources: {},
        tools: {},
      }),
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("write_failed");
  });
});
