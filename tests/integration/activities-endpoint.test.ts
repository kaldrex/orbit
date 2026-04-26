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

const { POST } = await import("../../src/app/api/v1/activities/route");

const PERSON_ID = "11111111-1111-4111-8111-111111111111";

function req(body: unknown): Request {
  return new Request("http://localhost/api/v1/activities", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function body() {
  return {
    person_id: PERSON_ID,
    type: "meeting",
    title: "Hardeep <> Keith — LocalHost Sponsorship",
    occurred_at: "2026-04-26T18:00:00Z",
    duration_minutes: 45,
    source: "hermes:granola",
    notes: "Discussed pricing tiers.",
    action_items: ["Adjust pricing tiers"],
    outcome: "follow_up_scheduled",
  };
}

describe("POST /api/v1/activities", () => {
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
    const res = await POST(req({ ...body(), person_id: "not-uuid" }));
    expect(res.status).toBe(400);
  });

  it("404 when person is missing", async () => {
    personExists = false;
    const res = await POST(req(body()));
    expect(res.status).toBe(404);
  });

  it("writes a linked meeting interaction observation", async () => {
    const res = await POST(req(body()));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(rpcCalls[0].name).toBe("upsert_observations");

    const rows = rpcCalls[0].args.p_rows as Array<{
      kind: string;
      observed_at: string;
      payload: Record<string, unknown>;
    }>;
    expect(rows[0].kind).toBe("interaction");
    expect(rows[0].observed_at).toBe("2026-04-26T18:00:00Z");
    expect(rows[0].payload.target_person_id).toBe(PERSON_ID);
    expect(rows[0].payload.channel).toBe("meeting");
    expect(rows[0].payload.title).toBe(body().title);
    expect(rows[0].payload.action_items).toEqual(["Adjust pricing tiers"]);
  });

  it("502 when write RPC fails", async () => {
    writeError = { message: "boom" };
    const res = await POST(req(body()));
    expect(res.status).toBe(502);
  });
});
