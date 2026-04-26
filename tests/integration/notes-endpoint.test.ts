import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthMock = vi.fn();
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let personExists = true;
let writeError: unknown = null;

vi.mock("@/lib/api-auth", () => ({
  getAgentOrSessionAuth: getAuthMock,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: personExists ? { id: PERSON_ID } : null,
              error: null,
            }),
          }),
        }),
      }),
    }),
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return {
        data: [{ inserted: 1, deduped: 0, inserted_ids: ["obs-1"] }],
        error: writeError,
      };
    },
  }),
}));

const { POST } = await import("../../src/app/api/v1/notes/route");

const PERSON_ID = "11111111-1111-4111-8111-111111111111";

function req(body: unknown): Request {
  return new Request("http://localhost/api/v1/notes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function body() {
  return {
    person_id: PERSON_ID,
    content: "Keith mentioned he is raising in Q3.",
    source: "hermes:imessage",
    created_at: "2026-04-26T15:30:00Z",
  };
}

describe("POST /api/v1/notes", () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    getAuthMock.mockReset();
    getAuthMock.mockResolvedValue({ userId: "user-1", selfNodeId: null });
    personExists = true;
    writeError = null;
  });

  it("401 when not authenticated", async () => {
    getAuthMock.mockResolvedValueOnce(null);
    const res = await POST(req(body()));
    expect(res.status).toBe(401);
  });

  it("rejects invalid body", async () => {
    const res = await POST(req({ ...body(), content: "" }));
    expect(res.status).toBe(400);
  });

  it("404 when person is missing", async () => {
    personExists = false;
    const res = await POST(req(body()));
    expect(res.status).toBe(404);
  });

  it("writes a linked note observation", async () => {
    const res = await POST(req(body()));
    expect(res.status).toBe(200);
    const rows = rpcCalls[0].args.p_rows as Array<{
      kind: string;
      observed_at: string;
      payload: Record<string, unknown>;
    }>;
    expect(rows[0].kind).toBe("note");
    expect(rows[0].observed_at).toBe("2026-04-26T15:30:00Z");
    expect(rows[0].payload.target_person_id).toBe(PERSON_ID);
    expect(rows[0].payload.content).toContain("raising");
    expect(rows[0].payload.source).toBe("hermes:imessage");
  });

  it("502 when write RPC fails", async () => {
    writeError = { message: "boom" };
    const res = await POST(req(body()));
    expect(res.status).toBe(502);
  });
});
