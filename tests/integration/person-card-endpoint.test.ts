import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthMock = vi.fn();
let rpcData: unknown = [];
let rpcError: unknown = null;
let fromPersonsRow: { id: string } | null = null;

vi.mock("@/lib/api-auth", () => ({
  getAgentOrSessionAuth: getAuthMock,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async () => ({ data: rpcData, error: rpcError }),
    from: (_table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: fromPersonsRow, error: null }),
          }),
        }),
      }),
    }),
  }),
}));

const { GET } = await import(
  "../../src/app/api/v1/person/[id]/card/route"
);

const personId = "11111111-1111-4111-8111-111111111111";

function req(id = personId): Request {
  return new Request(`http://localhost/api/v1/person/${id}/card`);
}

describe("GET /api/v1/person/:id/card", () => {
  beforeEach(() => {
    getAuthMock.mockReset();
    getAuthMock.mockResolvedValue({ userId: "user-1", selfNodeId: null });
    rpcData = [];
    rpcError = null;
    fromPersonsRow = null;
  });

  it("400 on non-uuid id", async () => {
    const res = await GET(req("not-a-uuid"), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
  });

  it("401 when not authenticated", async () => {
    getAuthMock.mockResolvedValueOnce(null);
    const res = await GET(req(), { params: Promise.resolve({ id: personId }) });
    expect(res.status).toBe(401);
  });

  it("404 when person doesn't exist and no observations", async () => {
    rpcData = [];
    fromPersonsRow = null;
    const res = await GET(req(), { params: Promise.resolve({ id: personId }) });
    expect(res.status).toBe(404);
  });

  it("200 empty-card when person exists but no observations", async () => {
    rpcData = [];
    fromPersonsRow = { id: personId };
    const res = await GET(req(), { params: Promise.resolve({ id: personId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.card.person_id).toBe(personId);
    expect(body.card.name).toBeNull();
  });

  it("200 with assembled card when observations present", async () => {
    rpcData = [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        user_id: "user-1",
        observed_at: "2026-04-10T00:00:00Z",
        ingested_at: "2026-04-19T00:00:00Z",
        observer: "wazowski",
        kind: "person",
        evidence_pointer: "wacli://contacts/jid=X",
        confidence: 0.9,
        reasoning: "seen as contact",
        payload: {
          name: "Umayr",
          company: "SinX",
          category: "team",
          title: "Co-founder",
          relationship_to_me: "work partner",
          phones: ["+971586783040"],
          emails: ["usheik@sinx.ai"],
        },
      },
    ];
    const res = await GET(req(), { params: Promise.resolve({ id: personId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.card.name).toBe("Umayr");
    expect(body.card.phones).toEqual(["+971586783040"]);
  });

  it("502 on DB error", async () => {
    rpcError = { message: "boom" };
    const res = await GET(req(), { params: Promise.resolve({ id: personId }) });
    expect(res.status).toBe(502);
  });
});
