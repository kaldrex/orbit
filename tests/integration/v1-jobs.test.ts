import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthMock = vi.fn();
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

let claimRpcResponse: { data: unknown; error: unknown } = {
  data: [],
  error: null,
};
let reportRpcResponse: { data: unknown; error: unknown } = {
  data: true,
  error: null,
};

vi.mock("@/lib/api-auth", () => ({
  getAgentOrSessionAuth: getAuthMock,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === "claim_next_job") return claimRpcResponse;
      if (name === "report_job_result") return reportRpcResponse;
      return { data: null, error: { message: `unexpected rpc: ${name}` } };
    },
  }),
}));

const { POST: claimPost } = await import(
  "../../src/app/api/v1/jobs/claim/route"
);
const { POST: reportPost } = await import(
  "../../src/app/api/v1/jobs/report/route"
);

function postClaim(body: unknown): Request {
  return new Request("http://localhost/api/v1/jobs/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function postReport(body: unknown): Request {
  return new Request("http://localhost/api/v1/jobs/report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/v1/jobs/claim", () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    getAuthMock.mockReset();
    getAuthMock.mockResolvedValue({ userId: "user-1", selfNodeId: null });
    claimRpcResponse = { data: [], error: null };
  });

  it("returns 401 when unauthenticated", async () => {
    getAuthMock.mockResolvedValueOnce(null);
    const res = await claimPost(
      postClaim({ agent: "wazowski", kinds: ["observer"] }),
    );
    expect(res.status).toBe(401);
    expect(rpcCalls).toHaveLength(0);
  });

  it("returns {job:null} when the queue is empty", async () => {
    claimRpcResponse = { data: [], error: null };
    const res = await claimPost(
      postClaim({ agent: "wazowski", kinds: ["observer", "enricher"] }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.job).toBeNull();
    expect(rpcCalls[0].name).toBe("claim_next_job");
    expect(rpcCalls[0].args.p_user_id).toBe("user-1");
    expect(rpcCalls[0].args.p_agent_id).toBe("wazowski");
    expect(rpcCalls[0].args.p_kinds).toEqual(["observer", "enricher"]);
  });

  it("returns the claimed job envelope", async () => {
    claimRpcResponse = {
      data: [
        {
          id: "3a0a0a0a-0000-4000-8000-000000000001",
          kind: "observer",
          payload: { seed: "971586783040@s.whatsapp.net" },
          attempts: 1,
          created_at: "2026-04-21T05:00:00+00:00",
        },
      ],
      error: null,
    };
    const res = await claimPost(
      postClaim({ agent: "wazowski", kinds: ["observer"] }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.job.id).toBe("3a0a0a0a-0000-4000-8000-000000000001");
    expect(body.job.kind).toBe("observer");
    expect(body.job.payload.seed).toBe("971586783040@s.whatsapp.net");
    expect(body.job.attempts).toBe(1);
  });

  it("rejects body missing required fields with 400", async () => {
    const res = await claimPost(postClaim({ agent: "wazowski" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_body");
    expect(rpcCalls).toHaveLength(0);
  });

  it("rejects empty kinds array with 400", async () => {
    const res = await claimPost(postClaim({ agent: "wazowski", kinds: [] }));
    expect(res.status).toBe(400);
    expect(rpcCalls).toHaveLength(0);
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await claimPost(postClaim("{ broken"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_json");
  });

  it("returns 502 when the RPC errors", async () => {
    claimRpcResponse = { data: null, error: { message: "db down" } };
    const res = await claimPost(
      postClaim({ agent: "wazowski", kinds: ["observer"] }),
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("claim_failed");
  });
});

describe("POST /api/v1/jobs/report", () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    getAuthMock.mockReset();
    getAuthMock.mockResolvedValue({ userId: "user-1", selfNodeId: null });
    reportRpcResponse = { data: true, error: null };
  });

  it("returns 401 when unauthenticated", async () => {
    getAuthMock.mockResolvedValueOnce(null);
    const res = await reportPost(
      postReport({
        job_id: "3a0a0a0a-0000-4000-8000-000000000001",
        status: "succeeded",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("reports success and returns {ok:true}", async () => {
    const res = await reportPost(
      postReport({
        job_id: "3a0a0a0a-0000-4000-8000-000000000001",
        status: "succeeded",
        result: { inserted: 12, deduped: 3 },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(rpcCalls[0].name).toBe("report_job_result");
    expect(rpcCalls[0].args.p_job_id).toBe(
      "3a0a0a0a-0000-4000-8000-000000000001",
    );
    expect(rpcCalls[0].args.p_user_id).toBe("user-1");
    expect(rpcCalls[0].args.p_status).toBe("succeeded");
    const result = rpcCalls[0].args.p_result as Record<string, unknown>;
    expect(result.inserted).toBe(12);
  });

  it("merges error string into the stored result payload", async () => {
    const res = await reportPost(
      postReport({
        job_id: "3a0a0a0a-0000-4000-8000-000000000001",
        status: "failed",
        error: "anthropic rate-limited",
      }),
    );
    expect(res.status).toBe(200);
    const result = rpcCalls[0].args.p_result as Record<string, unknown>;
    expect(result.error).toBe("anthropic rate-limited");
  });

  it("accepts status='retry' and passes through to RPC", async () => {
    const res = await reportPost(
      postReport({
        job_id: "3a0a0a0a-0000-4000-8000-000000000001",
        status: "retry",
      }),
    );
    expect(res.status).toBe(200);
    expect(rpcCalls[0].args.p_status).toBe("retry");
  });

  it("rejects invalid status with 400", async () => {
    const res = await reportPost(
      postReport({
        job_id: "3a0a0a0a-0000-4000-8000-000000000001",
        status: "weird",
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_body");
  });

  it("rejects non-UUID job_id with 400", async () => {
    const res = await reportPost(
      postReport({ job_id: "not-a-uuid", status: "succeeded" }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when RPC reports no row updated", async () => {
    reportRpcResponse = { data: false, error: null };
    const res = await reportPost(
      postReport({
        job_id: "3a0a0a0a-0000-4000-8000-000000000002",
        status: "succeeded",
      }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("not_found");
  });

  it("returns 502 when the RPC errors", async () => {
    reportRpcResponse = { data: null, error: { message: "boom" } };
    const res = await reportPost(
      postReport({
        job_id: "3a0a0a0a-0000-4000-8000-000000000001",
        status: "succeeded",
      }),
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("report_failed");
  });
});
