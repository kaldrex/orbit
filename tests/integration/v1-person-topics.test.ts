import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthMock = vi.fn();
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let upsertReturn: number = 0;
let selectReturn: Array<{ topic: string; weight: number }> = [];
let rpcError: { message: string } | null = null;

vi.mock("@/lib/api-auth", () => ({
  getAgentOrSessionAuth: getAuthMock,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (rpcError) return { data: null, error: rpcError };
      if (name === "upsert_person_topics") {
        return { data: upsertReturn, error: null };
      }
      if (name === "select_person_topics") {
        return { data: selectReturn, error: null };
      }
      return { data: null, error: null };
    },
  }),
}));

const { POST, GET } = await import(
  "../../src/app/api/v1/person/[id]/topics/route"
);

const personId = "11111111-1111-4111-8111-111111111111";

function postReq(body: unknown, id = personId): Request {
  return new Request(`http://localhost/api/v1/person/${id}/topics`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function getReq(id = personId, qs = ""): Request {
  return new Request(`http://localhost/api/v1/person/${id}/topics${qs}`);
}

describe("POST+GET /api/v1/person/:id/topics", () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    getAuthMock.mockReset();
    getAuthMock.mockResolvedValue({ userId: "user-1", selfNodeId: null });
    upsertReturn = 0;
    selectReturn = [];
    rpcError = null;
  });

  it("POST: 401 when not authenticated", async () => {
    getAuthMock.mockResolvedValueOnce(null);
    const res = await POST(postReq({ topics: [] }), {
      params: Promise.resolve({ id: personId }),
    });
    expect(res.status).toBe(401);
  });

  it("POST: 400 on non-uuid id", async () => {
    const res = await POST(postReq({ topics: [] }, "not-a-uuid"), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST: writes a dedup-normalized payload via upsert_person_topics", async () => {
    upsertReturn = 3;
    const body = {
      topics: [
        { topic: "Aakaar", weight: 0.9 },
        { topic: "  aakaar ", weight: 0.95 }, // dup, last wins after trim/lower
        { topic: "fundraising", weight: 0.4 },
        { topic: "sponsors", weight: 0.3 },
      ],
    };
    const res = await POST(postReq(body), { params: Promise.resolve({ id: personId }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ count: 3 });

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].name).toBe("upsert_person_topics");
    expect(rpcCalls[0].args.p_person_id).toBe(personId);
    expect(rpcCalls[0].args.p_user_id).toBe("user-1");
    const payload = rpcCalls[0].args.p_topics as Array<{ topic: string; weight: number }>;
    expect(payload).toHaveLength(3);
    expect(payload.map((t) => t.topic)).toEqual(["aakaar", "fundraising", "sponsors"]);
    // last-wins dedup on aakaar:
    expect(payload.find((t) => t.topic === "aakaar")?.weight).toBe(0.95);
  });

  it("POST: idempotent upsert — two calls replace (each call stands alone)", async () => {
    upsertReturn = 2;
    await POST(postReq({ topics: [{ topic: "a", weight: 1 }, { topic: "b", weight: 0.5 }] }), {
      params: Promise.resolve({ id: personId }),
    });
    await POST(postReq({ topics: [{ topic: "a", weight: 0.7 }, { topic: "c", weight: 0.3 }] }), {
      params: Promise.resolve({ id: personId }),
    });
    expect(rpcCalls).toHaveLength(2);
    // Each call sends its own full list — replacement semantics live server-side.
    expect((rpcCalls[0].args.p_topics as unknown[]).length).toBe(2);
    expect((rpcCalls[1].args.p_topics as unknown[]).length).toBe(2);
    const second = rpcCalls[1].args.p_topics as Array<{ topic: string; weight: number }>;
    expect(second.map((t) => t.topic).sort()).toEqual(["a", "c"]);
  });

  it("POST: 404 when RPC reports person doesn't belong to user (returns -1)", async () => {
    upsertReturn = -1;
    const res = await POST(postReq({ topics: [{ topic: "x", weight: 1 }] }), {
      params: Promise.resolve({ id: personId }),
    });
    expect(res.status).toBe(404);
  });

  it("GET: returns topics + total, sorted server-side", async () => {
    selectReturn = [
      { topic: "aakaar", weight: 0.95 },
      { topic: "fundraising", weight: 0.4 },
      { topic: "sponsors", weight: 0.3 },
    ];
    const res = await GET(getReq(personId, "?limit=3"), {
      params: Promise.resolve({ id: personId }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.total).toBe(3);
    expect(json.topics).toEqual([
      { topic: "aakaar", weight: 0.95 },
      { topic: "fundraising", weight: 0.4 },
      { topic: "sponsors", weight: 0.3 },
    ]);
    expect(rpcCalls[0].name).toBe("select_person_topics");
    expect(rpcCalls[0].args.p_limit).toBe(3);
  });
});
