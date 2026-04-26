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
      if (name === "upsert_observations") {
        return {
          data: [{
            inserted: 1,
            deduped: 0,
            inserted_ids: ["00000000-0000-4000-8000-000000000001"],
          }],
          error: writeError,
        };
      }
      return { data: [], error: null };
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

const { POST } = await import("../../src/app/api/v1/observation/route");

const PERSON_ID = "11111111-1111-4111-8111-111111111111";

function req(body: unknown): Request {
  return new Request("http://localhost/api/v1/observation", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function personRow(emails: string[] = []) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    user_id: "user-1",
    observed_at: "2026-04-26T12:00:00Z",
    ingested_at: "2026-04-26T12:00:00Z",
    observer: "wazowski",
    kind: "person",
    evidence_pointer: "manifest://person/1",
    confidence: 1,
    reasoning: "seed",
    payload: {
      name: "Hardeep Contact",
      category: "founder",
      relationship_to_me: "Known contact",
      phones: ["+15551234567"],
      emails,
    },
  };
}

describe("POST /api/v1/observation", () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    getAuthMock.mockReset();
    getAuthMock.mockResolvedValue({ userId: "user-1", selfNodeId: null });
    cardRows = [personRow(["old@example.com"])];
    cardError = null;
    writeError = null;
    personExists = true;
  });

  it("401 when not authenticated", async () => {
    getAuthMock.mockResolvedValueOnce(null);
    const res = await POST(req({
      person_id: PERSON_ID,
      email: "new@example.com",
      source: "hermes",
      confidence: 0.9,
    }));
    expect(res.status).toBe(401);
  });

  it("rejects invalid body", async () => {
    const res = await POST(req({
      person_id: PERSON_ID,
      email: "not-email",
      source: "hermes",
      confidence: 0.9,
    }));
    expect(res.status).toBe(400);
  });

  it("writes an email correction preserving existing emails", async () => {
    const res = await POST(req({
      person_id: PERSON_ID,
      email: "NEW@Example.com",
      source: "hermes",
      confidence: 0.92,
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.email).toBe("new@example.com");

    expect(rpcCalls[0].name).toBe("select_person_card_rows");
    expect(rpcCalls[1].name).toBe("upsert_observations");

    const rows = rpcCalls[1].args.p_rows as Array<{
      confidence: number;
      payload: { field: string; old_value: string[]; new_value: string[] };
    }>;
    expect(rows[0].confidence).toBe(0.92);
    expect(rows[0].payload.field).toBe("emails");
    expect(rows[0].payload.old_value).toEqual(["old@example.com"]);
    expect(rows[0].payload.new_value).toEqual([
      "old@example.com",
      "new@example.com",
    ]);
  });

  it("does not duplicate an existing email", async () => {
    cardRows = [personRow(["new@example.com"])];
    const res = await POST(req({
      person_id: PERSON_ID,
      email: "new@example.com",
      source: "hermes",
      confidence: 1,
    }));

    expect(res.status).toBe(200);
    const rows = rpcCalls[1].args.p_rows as Array<{
      payload: { new_value: string[] };
    }>;
    expect(rows[0].payload.new_value).toEqual(["new@example.com"]);
  });

  it("404 when the person does not exist", async () => {
    cardRows = [];
    personExists = false;
    const res = await POST(req({
      person_id: PERSON_ID,
      email: "new@example.com",
      source: "hermes",
      confidence: 1,
    }));

    expect(res.status).toBe(404);
  });

  it("502 when the write RPC fails", async () => {
    writeError = { message: "boom" };
    const res = await POST(req({
      person_id: PERSON_ID,
      email: "new@example.com",
      source: "hermes",
      confidence: 1,
    }));

    expect(res.status).toBe(502);
  });
});
