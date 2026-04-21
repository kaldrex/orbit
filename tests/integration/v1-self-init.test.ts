import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// /api/v1/self/init — resolves the authed user's own person_id via
// ORBIT_SELF_EMAIL (comma-tolerant) against kind='person' observations and
// writes profiles.self_node_id. Backed by resolve_self_node_id RPC.
// ---------------------------------------------------------------------------

const getAuthMock = vi.fn();
const rpcMock = vi.fn();

vi.mock("@/lib/api-auth", () => ({
  getAgentOrSessionAuth: getAuthMock,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: (name: string, args: Record<string, unknown>) => rpcMock(name, args),
  }),
}));

const { POST } = await import("../../src/app/api/v1/self/init/route");

function req(): Request {
  return new Request("http://localhost/api/v1/self/init", { method: "POST" });
}

describe("POST /api/v1/self/init", () => {
  beforeEach(() => {
    getAuthMock.mockReset();
    rpcMock.mockReset();
    process.env.ORBIT_SELF_EMAIL = "sanchay@example.com";
    process.env.ORBIT_SELF_PHONE = "";
    getAuthMock.mockResolvedValue({ userId: "user-1", selfNodeId: null });
  });

  it("401 when not authenticated", async () => {
    getAuthMock.mockResolvedValueOnce(null);
    const res = await POST(req());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("404 when ORBIT_SELF_EMAIL/PHONE both empty", async () => {
    process.env.ORBIT_SELF_EMAIL = "";
    process.env.ORBIT_SELF_PHONE = "";
    const res = await POST(req());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NO_IDENTITY_CONFIGURED");
  });

  it("404 when no kind='person' observation matches the configured email", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: null });
    const res = await POST(req());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
    expect(rpcMock).toHaveBeenCalledWith("resolve_self_node_id", {
      p_user_id: "user-1",
      p_emails: ["sanchay@example.com"],
      p_phones: [],
    });
  });

  it("returns {self_node_id} when the email matches an observation", async () => {
    rpcMock.mockResolvedValueOnce({
      data: "994a9f96-8cfc-4829-8062-87d7b900e4c6",
      error: null,
    });
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      self_node_id: "994a9f96-8cfc-4829-8062-87d7b900e4c6",
    });
  });

  it("splits comma-separated ORBIT_SELF_EMAIL to try multiple candidates", async () => {
    process.env.ORBIT_SELF_EMAIL = "primary@example.com, alias@example.com";
    rpcMock.mockResolvedValueOnce({
      data: "994a9f96-8cfc-4829-8062-87d7b900e4c6",
      error: null,
    });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("resolve_self_node_id", {
      p_user_id: "user-1",
      p_emails: ["primary@example.com", "alias@example.com"],
      p_phones: [],
    });
  });

  it("idempotent: already-resolved profile short-circuits without RPC", async () => {
    getAuthMock.mockResolvedValueOnce({
      userId: "user-1",
      selfNodeId: "994a9f96-8cfc-4829-8062-87d7b900e4c6",
    });
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      self_node_id: "994a9f96-8cfc-4829-8062-87d7b900e4c6",
    });
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
