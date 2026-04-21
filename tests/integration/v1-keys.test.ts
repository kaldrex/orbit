import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthMock = vi.fn();
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let rpcResponse: { data: unknown; error: unknown } = {
  data: [{ created_at: "2026-04-20T10:00:00+00:00" }],
  error: null,
};

// Simulates the duplicate-name check: default returns no existing row.
// Tests that want the "already exists" branch override `existingRow`.
let existingRow: { prefix: string; created_at: string } | null = null;
let existingErr: { message: string } | null = null;
const fromCalls: Array<{ table: string; filters: Record<string, unknown> }> = [];

vi.mock("@/lib/api-auth", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api-auth")>("@/lib/api-auth");
  return {
    getAgentOrSessionAuth: getAuthMock,
    generateApiKey: actual.generateApiKey,
  };
});

// Chainable mock for the duplicate-name lookup:
//   supabase.from("api_keys").select(...).eq(...).eq(...).is(...).maybeSingle()
// `rpc("mint_api_key", ...)` is still recorded in `rpcCalls`.
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const query = {
        select: (_cols: string) => query,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return query;
        },
        is: (col: string, val: unknown) => {
          filters[col] = val;
          return query;
        },
        maybeSingle: async () => {
          fromCalls.push({ table, filters: { ...filters } });
          if (existingErr) return { data: null, error: existingErr };
          return { data: existingRow, error: null };
        },
      };
      return query;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return rpcResponse;
    },
  }),
}));

const { POST } = await import("../../src/app/api/v1/keys/route");

function makeReq(body: unknown): Request {
  return new Request("http://localhost/api/v1/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "" : JSON.stringify(body),
  });
}

describe("POST /api/v1/keys", () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    fromCalls.length = 0;
    existingRow = null;
    existingErr = null;
    getAuthMock.mockReset();
    getAuthMock.mockResolvedValue({ userId: "user-1", selfNodeId: null });
    rpcResponse = {
      data: [{ created_at: "2026-04-20T10:00:00+00:00" }],
      error: null,
    };
  });

  it("returns 401 when not authenticated", async () => {
    getAuthMock.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ name: "test" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unauthorized");
  });

  it("mints a key and returns { key, prefix, name, created_at }", async () => {
    const res = await POST(makeReq({ name: "ci" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key).toMatch(/^orb_live_/);
    expect(body.prefix).toMatch(/^orb_live_/);
    expect(body.prefix).toHaveLength(12);
    expect(body.name).toBe("ci");
    expect(body.created_at).toBe("2026-04-20T10:00:00+00:00");

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].name).toBe("mint_api_key");
    expect(rpcCalls[0].args.p_user_id).toBe("user-1");
    expect(rpcCalls[0].args.p_name).toBe("ci");
    expect(typeof rpcCalls[0].args.p_key_hash).toBe("string");
    expect((rpcCalls[0].args.p_key_hash as string)).toHaveLength(64);
    expect(rpcCalls[0].args.p_prefix).toBe(body.prefix);

    // Duplicate-name check ran first with the expected filters.
    expect(fromCalls).toHaveLength(1);
    expect(fromCalls[0].table).toBe("api_keys");
    expect(fromCalls[0].filters).toEqual({
      user_id: "user-1",
      name: "ci",
      revoked_at: null,
    });
  });

  it("rejects empty body with name_required (no more silent default)", async () => {
    const res = await POST(
      new Request("http://localhost/api/v1/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("name_required");
    expect(rpcCalls).toHaveLength(0);
    expect(fromCalls).toHaveLength(0);
  });

  it("rejects empty/whitespace name with name_required", async () => {
    const res = await POST(makeReq({ name: "   " }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("name_required");
    expect(rpcCalls).toHaveLength(0);
  });

  it("rejects null name with name_required", async () => {
    const res = await POST(makeReq({ name: null }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("name_required");
    expect(rpcCalls).toHaveLength(0);
  });

  it("rejects invalid body (name too long)", async () => {
    const res = await POST(makeReq({ name: "x".repeat(200) }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_body");
    expect(rpcCalls).toHaveLength(0);
  });

  it("rejects malformed JSON", async () => {
    const res = await POST(
      new Request("http://localhost/api/v1/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_json");
  });

  it("returns 502 when RPC errors", async () => {
    rpcResponse = { data: null, error: { message: "boom" } };
    const res = await POST(makeReq({ name: "test" }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("mint_failed");
  });

  it("response shape snapshot — key is exposed only in response, not logged", async () => {
    const res = await POST(makeReq({ name: "shape" }));
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual([
      "created_at",
      "key",
      "name",
      "prefix",
    ]);
  });

  // --------------------------------------------------------------------------
  // Idempotency contract added 2026-04-21 after the backend audit.
  // --------------------------------------------------------------------------

  it("returns 409 name_exists when an active key with the same name already exists", async () => {
    existingRow = {
      prefix: "orb_live_AAA",
      created_at: "2026-04-19T08:00:00+00:00",
    };
    const res = await POST(makeReq({ name: "dup-test" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("name_exists");
    expect(body.error.existing_prefix).toBe("orb_live_AAA");
    expect(body.error.existing_created_at).toBe("2026-04-19T08:00:00+00:00");
    expect(rpcCalls).toHaveLength(0); // never called mint_api_key
  });

  it("second POST with the same name does not mint — audit repro", async () => {
    // First call succeeds.
    const res1 = await POST(makeReq({ name: "dup-test" }));
    expect(res1.status).toBe(200);
    expect(rpcCalls).toHaveLength(1);

    // Simulate the table now containing the freshly-minted row.
    existingRow = { prefix: "orb_live_FRESH", created_at: "now" };

    // Second call with same name returns 409, no new mint.
    const res2 = await POST(makeReq({ name: "dup-test" }));
    expect(res2.status).toBe(409);
    const body2 = await res2.json();
    expect(body2.error.code).toBe("name_exists");
    expect(rpcCalls).toHaveLength(1); // still only the first mint
  });

  it("returns 502 if the duplicate-name probe itself errors", async () => {
    existingErr = { message: "db down" };
    const res = await POST(makeReq({ name: "probe-fail" }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("mint_failed");
    expect(rpcCalls).toHaveLength(0);
  });
});
