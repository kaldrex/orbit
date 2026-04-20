import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthMock = vi.fn();

let personsPayload: Array<{ id: string }> = [];
let personsError: unknown = null;
// Map person_id -> observation rows returned by select_person_observations
let obsMap: Record<string, unknown[]> = {};

vi.mock("@/lib/api-auth", () => ({
  getAgentOrSessionAuth: getAuthMock,
}));

// Kept as a harmless fallback (route no longer uses .from() directly —
// switched to select_persons_page RPC to bypass RLS under the ANON key).
function makeQueryBuilder() {
  const builder: any = {};
  builder.select = () => builder;
  builder.eq = () => builder;
  builder.order = () => builder;
  builder.gt = () => builder;
  builder.limit = async () => ({ data: personsPayload, error: personsError });
  return builder;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (_: string) => makeQueryBuilder(),
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "select_persons_page") {
        return { data: personsPayload, error: personsError };
      }
      if (name === "select_person_observations") {
        const id = args.p_person_id as string;
        return { data: obsMap[id] ?? [], error: null };
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

function enrichedPersonObs(id: string, payload: Record<string, unknown>) {
  return {
    id: `obs-${id}`,
    user_id: "user-1",
    observed_at: "2026-04-19T08:22:00+00:00",
    ingested_at: "2026-04-19T08:22:00+00:00",
    observer: "wazowski",
    kind: "person",
    evidence_pointer: "wacli://contacts/jid=X",
    confidence: 0.95,
    reasoning: "enriched",
    payload,
  };
}

describe("GET /api/v1/persons/enriched", () => {
  beforeEach(() => {
    getAuthMock.mockReset();
    getAuthMock.mockResolvedValue({ userId: "user-1", selfNodeId: null });
    personsPayload = [];
    personsError = null;
    obsMap = {};
  });

  it("401 when not authenticated", async () => {
    getAuthMock.mockResolvedValueOnce(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it("returns empty when no persons", async () => {
    personsPayload = [];
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.persons).toEqual([]);
    expect(body.next_cursor).toBeNull();
  });

  it("includes persons with non-'other' category", async () => {
    const umayrId = "67050b91-5011-4ba6-b230-9a387879717a";
    personsPayload = [{ id: umayrId }];
    obsMap[umayrId] = [
      enrichedPersonObs(umayrId, {
        name: "Umayr Sheik",
        category: "team",
        phones: ["+971586783040"],
        emails: ["usheik@sinx.ai"],
        company: "SinX Solutions",
        title: "Founder",
        relationship_to_me: "Close friend",
      }),
    ];
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.persons).toHaveLength(1);
    expect(body.persons[0].name).toBe("Umayr Sheik");
    expect(body.persons[0].category).toBe("team");
    expect(body.persons[0].relationship_to_me).toBe("Close friend");
  });

  it("excludes persons with category='other' and empty relationship_to_me (pure seed)", async () => {
    const seedId = "11111111-1111-4111-8111-111111111111";
    personsPayload = [{ id: seedId }];
    obsMap[seedId] = [
      enrichedPersonObs(seedId, {
        name: "Anonymous Seed",
        category: "other",
        phones: ["+91999"],
        emails: [],
        company: null,
        title: null,
        relationship_to_me: "",
      }),
    ];
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.persons).toHaveLength(0);
  });

  it("excludes persons whose relationship_to_me is the legacy placeholder prose", async () => {
    const id = "11111111-1111-4111-8111-111111111222";
    personsPayload = [{ id }];
    obsMap[id] = [
      enrichedPersonObs(id, {
        name: "PlaceholderGuy",
        category: "other",
        phones: ["+91888"],
        emails: [],
        company: null,
        title: null,
        relationship_to_me: "Appears in 3 threads across 2 channels. Pending enrichment.",
      }),
    ];
    const res = await GET(req());
    const body = await res.json();
    expect(body.persons).toHaveLength(0);
  });

  it("includes persons with non-empty real relationship_to_me even if category is 'other'", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    personsPayload = [{ id }];
    obsMap[id] = [
      enrichedPersonObs(id, {
        name: "Ramon",
        category: "other",
        phones: ["+17874244135"],
        emails: [],
        company: null,
        title: null,
        relationship_to_me: "Freelance client and close collaborator.",
      }),
    ];
    const res = await GET(req());
    const body = await res.json();
    expect(body.persons).toHaveLength(1);
    expect(body.persons[0].relationship_to_me).toMatch(/^Freelance/);
  });

  it("rejects invalid cursor", async () => {
    const res = await GET(req("http://localhost/api/v1/persons/enriched?cursor=not-uuid"));
    expect(res.status).toBe(400);
  });

  it("rejects invalid limit", async () => {
    const res = await GET(req("http://localhost/api/v1/persons/enriched?limit=0"));
    expect(res.status).toBe(400);
  });

  it("returns next_cursor when page is full", async () => {
    // Build 3 enriched persons; request limit=3, expect cursor to point to the last.
    const ids = [
      "44444444-4444-4444-8444-444444444441",
      "44444444-4444-4444-8444-444444444442",
      "44444444-4444-4444-8444-444444444443",
    ];
    personsPayload = ids.map((id) => ({ id }));
    for (const id of ids) {
      obsMap[id] = [
        enrichedPersonObs(id, {
          name: "X",
          category: "team",
          phones: [],
          emails: [],
          company: null,
          title: null,
          relationship_to_me: "",
        }),
      ];
    }
    const res = await GET(
      req("http://localhost/api/v1/persons/enriched?limit=3"),
    );
    const body = await res.json();
    expect(body.persons).toHaveLength(3);
    // When the materialization page is full (size == limit) the cursor is set.
    expect(body.next_cursor).toBe(ids[ids.length - 1]);
  });

  it("surfaces 502 on persons query error", async () => {
    personsError = { message: "boom" };
    personsPayload = [];
    const res = await GET(req());
    expect(res.status).toBe(502);
  });
});
