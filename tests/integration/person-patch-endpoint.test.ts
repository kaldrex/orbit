import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthMock = vi.fn();
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let cardRows: unknown[] = [];
let cardError: unknown = null;
let writeError: unknown = null;
let personExists = true;

vi.mock("@/lib/api-auth", () => ({
  getAgentOrSessionAuth: getAuthMock,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === "select_person_card_rows") {
        return { data: cardRows, error: cardError };
      }
      return {
        data: [{ inserted: 2, deduped: 0, inserted_ids: ["obs-1", "obs-2"] }],
        error: writeError,
      };
    },
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
  }),
}));

const { PATCH } = await import("../../src/app/api/v1/persons/[id]/route");

const PERSON_ID = "11111111-1111-4111-8111-111111111111";

function req(body: unknown, id = PERSON_ID): Request {
  return new Request(`http://localhost/api/v1/persons/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function personRow() {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    user_id: "user-1",
    observed_at: "2026-04-26T12:00:00Z",
    ingested_at: "2026-04-26T12:00:00Z",
    observer: "wazowski",
    kind: "person",
    evidence_pointer: "test://person",
    confidence: 1,
    reasoning: "seed",
    payload: {
      name: "Keith",
      company: null,
      title: null,
      category: "other",
      relationship_to_me: "",
      phones: [],
      emails: [],
    },
  };
}

describe("PATCH /api/v1/persons/:id", () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    getAuthMock.mockReset();
    getAuthMock.mockResolvedValue({ userId: "user-1", selfNodeId: null });
    cardRows = [personRow()];
    cardError = null;
    writeError = null;
    personExists = true;
  });

  it("400 on invalid UUID", async () => {
    const res = await PATCH(req({ company: "SoulScape" }, "bad"), {
      params: Promise.resolve({ id: "bad" }),
    });
    expect(res.status).toBe(400);
  });

  it("401 when not authenticated", async () => {
    getAuthMock.mockResolvedValueOnce(null);
    const res = await PATCH(req({ company: "SoulScape" }), {
      params: Promise.resolve({ id: PERSON_ID }),
    });
    expect(res.status).toBe(401);
  });

  it("400 on invalid category", async () => {
    const res = await PATCH(req({ category: "vip" }), {
      params: Promise.resolve({ id: PERSON_ID }),
    });
    expect(res.status).toBe(400);
  });

  it("400 when no fields are provided", async () => {
    const res = await PATCH(req({}), {
      params: Promise.resolve({ id: PERSON_ID }),
    });
    expect(res.status).toBe(400);
  });

  it("404 when person is missing", async () => {
    cardRows = [];
    personExists = false;
    const res = await PATCH(req({ company: "SoulScape" }), {
      params: Promise.resolve({ id: PERSON_ID }),
    });
    expect(res.status).toBe(404);
  });

  it("writes one correction per changed field", async () => {
    const res = await PATCH(req({
      company: "SoulScape",
      title: "Founder",
      category: "investor",
      relationship_strength: "warm",
    }), {
      params: Promise.resolve({ id: PERSON_ID }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.updated_fields).toEqual([
      "company",
      "title",
      "category",
      "relationship_strength",
    ]);

    expect(rpcCalls[0].name).toBe("select_person_card_rows");
    expect(rpcCalls[1].name).toBe("upsert_observations");
    const rows = rpcCalls[1].args.p_rows as Array<{
      kind: string;
      payload: { target_person_id: string; field: string; new_value: unknown };
    }>;
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.kind === "correction")).toBe(true);
    expect(rows.map((r) => r.payload.field)).toContain("relationship_strength");
    expect(rows[0].payload.target_person_id).toBe(PERSON_ID);
  });
});
