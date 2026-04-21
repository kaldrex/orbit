import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthMock = vi.fn();
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

let selectRpcResponse: { data: unknown; error: unknown } = {
  data: [],
  error: null,
};
let upsertRpcResponse: { data: unknown; error: unknown } = {
  data: "2026-04-21T10:00:00+00:00",
  error: null,
};

vi.mock("@/lib/api-auth", () => ({
  getAgentOrSessionAuth: getAuthMock,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === "select_upcoming_meetings") return selectRpcResponse;
      if (name === "upsert_meeting") return upsertRpcResponse;
      return { data: null, error: { message: `unexpected rpc: ${name}` } };
    },
  }),
}));

const { GET, POST } = await import(
  "../../src/app/api/v1/meetings/upcoming/route"
);

function getReq(url = "http://localhost/api/v1/meetings/upcoming"): Request {
  return new Request(url);
}

function postReq(body: unknown): Request {
  return new Request("http://localhost/api/v1/meetings/upcoming", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("GET /api/v1/meetings/upcoming", () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    getAuthMock.mockReset();
    getAuthMock.mockResolvedValue({ userId: "user-1", selfNodeId: null });
    selectRpcResponse = { data: [], error: null };
  });

  it("returns 401 when not authenticated", async () => {
    getAuthMock.mockResolvedValueOnce(null);
    const res = await GET(getReq());
    expect(res.status).toBe(401);
  });

  it("returns empty list when the RPC has no rows", async () => {
    selectRpcResponse = { data: [], error: null };
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meetings).toEqual([]);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].name).toBe("select_upcoming_meetings");
    expect(rpcCalls[0].args.p_user_id).toBe("user-1");
    expect(rpcCalls[0].args.p_horizon_hours).toBe(72);
  });

  it("maps rows to the dashboard shape and honors horizon_hours", async () => {
    selectRpcResponse = {
      data: [
        {
          meeting_id: "evt-umayr-1",
          title: "Umayr 1:1",
          start_at: "2026-04-22T09:00:00+00:00",
          end_at: "2026-04-22T09:30:00+00:00",
          attendees_json: [
            { email: "usheik@sinx.ai", name: "Umayr Sheik" },
            { email: "sanchay@localhost.ai" },
          ],
          brief_md: "Shared history: Sinx fundraise.",
          generated_at: "2026-04-21T08:00:00+00:00",
        },
      ],
      error: null,
    };

    const res = await GET(
      getReq("http://localhost/api/v1/meetings/upcoming?horizon_hours=48"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meetings).toHaveLength(1);
    const m = body.meetings[0];
    expect(m.meeting_id).toBe("evt-umayr-1");
    expect(m.title).toBe("Umayr 1:1");
    expect(m.start_at).toBe("2026-04-22T09:00:00+00:00");
    expect(m.brief_md).toBe("Shared history: Sinx fundraise.");
    expect(m.attendees).toEqual([
      { email: "usheik@sinx.ai", name: "Umayr Sheik" },
      { email: "sanchay@localhost.ai" },
    ]);
    expect(rpcCalls[0].args.p_horizon_hours).toBe(48);
  });

  it("rejects invalid horizon_hours with 400", async () => {
    const res = await GET(
      getReq("http://localhost/api/v1/meetings/upcoming?horizon_hours=0"),
    );
    expect(res.status).toBe(400);
    expect(rpcCalls).toHaveLength(0);
  });

  it("returns 502 on RPC error", async () => {
    selectRpcResponse = { data: null, error: { message: "boom" } };
    const res = await GET(getReq());
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("read_failed");
  });
});

describe("POST /api/v1/meetings/upcoming", () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    getAuthMock.mockReset();
    getAuthMock.mockResolvedValue({ userId: "user-1", selfNodeId: null });
    upsertRpcResponse = { data: "2026-04-21T10:00:00+00:00", error: null };
  });

  it("returns 401 when not authenticated", async () => {
    getAuthMock.mockResolvedValueOnce(null);
    const res = await POST(
      postReq({
        meetings: [
          {
            meeting_id: "x",
            start_at: "2026-04-22T09:00:00+00:00",
            attendees: [{ email: "a@b.com" }],
          },
        ],
      }),
    );
    expect(res.status).toBe(401);
  });

  it("upserts each meeting and returns { upserted: N }", async () => {
    const res = await POST(
      postReq({
        meetings: [
          {
            meeting_id: "evt-1",
            title: "Founder sync",
            start_at: "2026-04-22T09:00:00+00:00",
            end_at: "2026-04-22T09:30:00+00:00",
            attendees: [{ email: "umayr@sinx.ai", name: "Umayr Sheik" }],
            brief_md: "Shared history on Sinx.",
          },
          {
            meeting_id: "evt-2",
            title: "Investor update",
            start_at: "2026-04-23T15:00:00+00:00",
            attendees: [],
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.upserted).toBe(2);
    expect(rpcCalls).toHaveLength(2);
    expect(rpcCalls[0].name).toBe("upsert_meeting");
    expect(rpcCalls[0].args.p_user_id).toBe("user-1");
    expect(rpcCalls[0].args.p_meeting_id).toBe("evt-1");
    expect(rpcCalls[0].args.p_title).toBe("Founder sync");
    expect(rpcCalls[0].args.p_start_at).toBe("2026-04-22T09:00:00+00:00");
    expect(rpcCalls[0].args.p_brief_md).toBe("Shared history on Sinx.");
    expect(rpcCalls[1].args.p_meeting_id).toBe("evt-2");
    expect(rpcCalls[1].args.p_brief_md).toBe(null);
  });

  it("rejects body missing required fields", async () => {
    const res = await POST(postReq({ meetings: [{ meeting_id: "x" }] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_body");
    expect(rpcCalls).toHaveLength(0);
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await POST(postReq("{ not-json"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_json");
  });

  it("returns 502 when upsert_meeting errors mid-batch", async () => {
    upsertRpcResponse = { data: null, error: { message: "db down" } };
    const res = await POST(
      postReq({
        meetings: [
          {
            meeting_id: "evt-1",
            start_at: "2026-04-22T09:00:00+00:00",
            attendees: [],
          },
        ],
      }),
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("write_failed");
    expect(body.error.upserted_before_failure).toBe(0);
  });
});
