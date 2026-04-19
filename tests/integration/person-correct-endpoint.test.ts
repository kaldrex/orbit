import { describe, it, expect, vi, beforeEach } from "vitest";

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
        data: [{ inserted: 1, deduped: 0 }],
        error: null,
      };
    },
  }),
}));

const { POST } = await import(
  "../../src/app/api/v1/person/[id]/correct/route"
);

const personId = "11111111-1111-4111-8111-111111111111";

function req(body: unknown, id = personId): Request {
  return new Request(`http://localhost/api/v1/person/${id}/correct`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/person/:id/correct", () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    getAuthMock.mockReset();
    getAuthMock.mockResolvedValue({ userId: "user-1", selfNodeId: null });
  });

  it("400 on non-uuid id", async () => {
    const r = req({ field: "name", new_value: "X" }, "not-a-uuid");
    const res = await POST(r, { params: Promise.resolve({ id: "not-a-uuid" }) });
    expect(res.status).toBe(400);
  });

  it("401 when not authenticated", async () => {
    getAuthMock.mockResolvedValueOnce(null);
    const res = await POST(
      req({ field: "name", new_value: "X" }),
      { params: Promise.resolve({ id: personId }) },
    );
    expect(res.status).toBe(401);
  });

  it("400 on invalid json", async () => {
    const raw = new Request(`http://localhost/api/v1/person/${personId}/correct`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(raw, { params: Promise.resolve({ id: personId }) });
    expect(res.status).toBe(400);
  });

  it("400 on missing field", async () => {
    const res = await POST(
      req({ new_value: "X" }),
      { params: Promise.resolve({ id: personId }) },
    );
    expect(res.status).toBe(400);
  });

  it("writes a correction observation via upsert_observations", async () => {
    const res = await POST(
      req({
        field: "company",
        new_value: "SinX",
        source: "telegram",
        reasoning: "founder correction in TG",
      }),
      { params: Promise.resolve({ id: personId }) },
    );
    expect(res.status).toBe(200);
    expect(rpcCalls[0].name).toBe("upsert_observations");
    const rows = rpcCalls[0].args.p_rows as Array<{
      kind: string;
      confidence: number;
      payload: { target_person_id: string; field: string; new_value: unknown };
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("correction");
    expect(rows[0].confidence).toBe(1);
    expect(rows[0].payload.target_person_id).toBe(personId);
    expect(rows[0].payload.field).toBe("company");
    expect(rows[0].payload.new_value).toBe("SinX");
  });

  it("defaults source to 'other' when omitted", async () => {
    await POST(
      req({ field: "name", new_value: "X" }),
      { params: Promise.resolve({ id: personId }) },
    );
    const rows = rpcCalls[0].args.p_rows as Array<{
      payload: { source: string };
    }>;
    expect(rows[0].payload.source).toBe("other");
  });
});
