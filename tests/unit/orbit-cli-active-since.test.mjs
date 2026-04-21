import { describe, it, expect } from "vitest";

import { orbitPersonsActiveSince } from "../../orbit-cli-plugin/lib/client.mjs";
import { resolveConfig } from "../../orbit-cli-plugin/lib/env.mjs";

function jsonResponse(body, { status = 200 } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Err",
    headers: {
      get(name) {
        if (name.toLowerCase() === "content-type") return "application/json";
        return null;
      },
    },
    async text() {
      return text;
    },
  };
}

function makeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length - 1);
  };
  fn.calls = calls;
  return fn;
}

const ENV = {
  ORBIT_API_BASE: "http://100.97.152.84:3047",
  ORBIT_API_KEY: "orb_live_test_active",
};
const CFG = resolveConfig(ENV).config;

describe("orbit_persons_active_since", () => {
  it("GET target shapes correctly with since param", async () => {
    const fetchMock = makeFetch(() => jsonResponse({ persons: [], total: 0 }));
    await orbitPersonsActiveSince(
      { since: "2026-04-20T00:00:00Z" },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(fetchMock.calls[0].url).toContain(
      "/api/v1/persons/active-since?since=2026-04-20T00%3A00%3A00Z",
    );
    expect(fetchMock.calls[0].url).not.toContain("/api/v1/api/v1");
    expect(fetchMock.calls[0].init.method).toBe("GET");
  });

  it("passes needs_enrichment=true in query when set", async () => {
    const fetchMock = makeFetch(() => jsonResponse({ persons: [], total: 0 }));
    await orbitPersonsActiveSince(
      { since: "2026-04-20T00:00:00Z", needs_enrichment: true },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(fetchMock.calls[0].url).toContain("needs_enrichment=true");
  });

  it("omits needs_enrichment from query when false/unset", async () => {
    const fetchMock = makeFetch(() => jsonResponse({ persons: [], total: 0 }));
    await orbitPersonsActiveSince(
      { since: "2026-04-20T00:00:00Z" },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(fetchMock.calls[0].url).not.toContain("needs_enrichment");
  });

  it("returns body unchanged on success", async () => {
    const body = {
      persons: [
        { person_id: "11111111-1111-4111-8111-111111111111", last_activity_at: "2026-04-21T00:00:00Z", activity_count: 3 },
      ],
      total: 1,
    };
    const fetchMock = makeFetch(() => jsonResponse(body));
    const r = await orbitPersonsActiveSince(
      { since: "2026-04-20T00:00:00Z" },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.total).toBe(1);
    expect(r.persons).toHaveLength(1);
  });

  it("rejects missing since locally (no fetch call)", async () => {
    const fetchMock = makeFetch(() => jsonResponse({ persons: [] }));
    const r = await orbitPersonsActiveSince({}, { config: CFG, fetchImpl: fetchMock });
    expect(r.error).toBeDefined();
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(fetchMock.calls).toHaveLength(0);
  });
});
