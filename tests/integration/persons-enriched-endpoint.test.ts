import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthMock = vi.fn();

// Rows returned by the select_enriched_persons RPC. Shape matches the
// RPC contract: 8 data fields + page_last_id.
let enrichedPayload: Array<{
  id: string | null;
  name: string | null;
  phones: string[] | null;
  emails: string[] | null;
  category: string | null;
  relationship_to_me: string | null;
  company: string | null;
  title: string | null;
  updated_at: string | null;
  page_last_id: string | null;
}> = [];
let enrichedError: unknown = null;

vi.mock("@/lib/api-auth", () => ({
  getAgentOrSessionAuth: getAuthMock,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (name: string, _args: Record<string, unknown>) => {
      if (name === "select_enriched_persons") {
        return { data: enrichedPayload, error: enrichedError };
      }
      return { data: [], error: null };
    },
  }),
}));

const { GET } = await import(
  "../../src/app/api/v1/persons/enriched/route"
);

function req(url = "http://localhost/api/v1/persons/enriched"): Request {
  return new Request(url);
}

function enrichedRow(
  id: string,
  fields: Partial<{
    name: string | null;
    phones: string[] | null;
    emails: string[] | null;
    category: string | null;
    relationship_to_me: string | null;
    company: string | null;
    title: string | null;
    updated_at: string | null;
    page_last_id: string | null;
  }> = {},
) {
  return {
    id,
    name: fields.name ?? null,
    phones: fields.phones ?? [],
    emails: fields.emails ?? [],
    category: fields.category ?? null,
    relationship_to_me: fields.relationship_to_me ?? "",
    company: fields.company ?? null,
    title: fields.title ?? null,
    updated_at: fields.updated_at ?? null,
    page_last_id: fields.page_last_id ?? null,
  };
}

describe("GET /api/v1/persons/enriched", () => {
  beforeEach(() => {
    getAuthMock.mockReset();
    getAuthMock.mockResolvedValue({ userId: "user-1", selfNodeId: null });
    enrichedPayload = [];
    enrichedError = null;
  });

  it("401 when not authenticated", async () => {
    getAuthMock.mockResolvedValueOnce(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it("returns empty when RPC returns no rows", async () => {
    enrichedPayload = [];
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.persons).toEqual([]);
    expect(body.next_cursor).toBeNull();
  });

  it("passes enriched persons through with the expected shape", async () => {
    const umayrId = "67050b91-5011-4ba6-b230-9a387879717a";
    enrichedPayload = [
      enrichedRow(umayrId, {
        name: "Umayr Sheik",
        category: "team",
        phones: ["+971586783040"],
        emails: ["usheik@sinx.ai"],
        company: "SinX Solutions",
        title: "Founder",
        relationship_to_me: "Close friend",
        updated_at: "2026-04-19T08:22:00+00:00",
        page_last_id: null,
      }),
    ];
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.persons).toHaveLength(1);
    expect(body.persons[0].id).toBe(umayrId);
    expect(body.persons[0].name).toBe("Umayr Sheik");
    expect(body.persons[0].category).toBe("team");
    expect(body.persons[0].relationship_to_me).toBe("Close friend");
    expect(body.persons[0].company).toBe("SinX Solutions");
    expect(body.persons[0].title).toBe("Founder");
    expect(body.persons[0].phones).toEqual(["+971586783040"]);
    expect(body.persons[0].emails).toEqual(["usheik@sinx.ai"]);
    expect(body.persons[0].updated_at).toBe("2026-04-19T08:22:00+00:00");
  });

  it("skips sentinel rows with id=null but uses their page_last_id", async () => {
    // Sentinel-only page: every person in the underlying page was filtered
    // out by the RPC's enriched predicate, but there are more pages to
    // scan — the caller must get a non-null next_cursor to keep paging.
    enrichedPayload = [
      enrichedRow("00000000-0000-0000-0000-000000000000", {
        page_last_id: "11111111-1111-1111-1111-111111111111",
      }),
    ];
    // Override to make the row's id explicitly null (sentinel).
    enrichedPayload[0].id = null;
    const res = await GET(req());
    const body = await res.json();
    expect(body.persons).toHaveLength(0);
    expect(body.next_cursor).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("rejects invalid cursor", async () => {
    const res = await GET(
      req("http://localhost/api/v1/persons/enriched?cursor=not-uuid"),
    );
    expect(res.status).toBe(400);
  });

  it("rejects invalid limit", async () => {
    const res = await GET(
      req("http://localhost/api/v1/persons/enriched?limit=0"),
    );
    expect(res.status).toBe(400);
  });

  it("returns next_cursor when the RPC marks the page as full", async () => {
    const ids = [
      "44444444-4444-4444-8444-444444444441",
      "44444444-4444-4444-8444-444444444442",
      "44444444-4444-4444-8444-444444444443",
    ];
    enrichedPayload = ids.map((id) =>
      enrichedRow(id, {
        name: "X",
        category: "team",
        page_last_id: ids[ids.length - 1],
      }),
    );
    const res = await GET(
      req("http://localhost/api/v1/persons/enriched?limit=3"),
    );
    const body = await res.json();
    expect(body.persons).toHaveLength(3);
    expect(body.next_cursor).toBe(ids[ids.length - 1]);
  });

  it("null page_last_id means no next cursor (short page)", async () => {
    enrichedPayload = [
      enrichedRow("55555555-5555-4555-8555-555555555555", {
        name: "EndOfList",
        category: "friend",
        page_last_id: null,
      }),
    ];
    const res = await GET(req());
    const body = await res.json();
    expect(body.persons).toHaveLength(1);
    expect(body.next_cursor).toBeNull();
  });

  it("surfaces 502 on RPC error", async () => {
    enrichedError = { message: "boom" };
    enrichedPayload = [];
    const res = await GET(req());
    expect(res.status).toBe(502);
  });
});

// ----------------------------------------------------------------------------
// Live dev-server latency smoke test.
//
// Gated on TEST_LIVE=1. Hits the running dev server (localhost:3047) with a
// real bearer token from .env.local and asserts the full-limit round-trip
// returns in under 3 s. Skipped in CI and default local runs so vitest stays
// green without a server.
// ----------------------------------------------------------------------------
const LIVE = process.env.TEST_LIVE === "1";
const LIVE_BASE =
  process.env.ORBIT_LIVE_URL ?? "http://localhost:3047/api/v1";
const LIVE_KEY = process.env.ORBIT_API_KEY ?? "";

describe.skipIf(!LIVE)("GET /api/v1/persons/enriched [live]", () => {
  it("returns under 3 s at limit=500", async () => {
    const t0 = Date.now();
    const res = await fetch(`${LIVE_BASE}/persons/enriched?limit=500`, {
      headers: { Authorization: `Bearer ${LIVE_KEY}` },
    });
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.persons)).toBe(true);
    console.log(
      `[live] /persons/enriched?limit=500 → ${body.persons.length} persons in ${elapsed} ms`,
    );
    expect(elapsed).toBeLessThan(3000);
  }, 10_000);
});
