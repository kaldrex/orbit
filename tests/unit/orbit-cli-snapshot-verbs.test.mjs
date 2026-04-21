import { describe, it, expect } from "vitest";

import {
  orbitPersonSnapshotWrite,
  orbitPersonSnapshotsList,
} from "../../orbit-cli-plugin/lib/client.mjs";
import { resolveConfig } from "../../orbit-cli-plugin/lib/env.mjs";

// ---------------------------------------------------------------------------
// Fetch mock — records (url, init) and returns scripted responses.
// ---------------------------------------------------------------------------

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
  ORBIT_API_KEY: "orb_live_test_snap",
};
const CFG = resolveConfig(ENV).config;

const PERSON_ID = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT_ID = "22222222-2222-4222-8222-222222222222";

// =========================================================================
// orbit_person_snapshot_write
// =========================================================================

describe("orbit_person_snapshot_write", () => {
  it("POST target is /api/v1/person/:id/snapshots (single /api/v1)", async () => {
    const fetchMock = makeFetch(() =>
      jsonResponse({ ok: true, id: SNAPSHOT_ID }),
    );
    const r = await orbitPersonSnapshotWrite(
      {
        person_id: PERSON_ID,
        pass_kind: "enricher",
        card_state: { category: "team" },
      },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.ok).toBe(true);
    expect(r.id).toBe(SNAPSHOT_ID);
    expect(fetchMock.calls).toHaveLength(1);
    expect(fetchMock.calls[0].url).toBe(
      `http://100.97.152.84:3047/api/v1/person/${PERSON_ID}/snapshots`,
    );
    expect(fetchMock.calls[0].url).not.toContain("/api/v1/api/v1");
    expect(fetchMock.calls[0].init.method).toBe("POST");
  });

  it("sends Authorization + serialized body", async () => {
    const fetchMock = makeFetch(() => jsonResponse({ ok: true, id: SNAPSHOT_ID }));
    await orbitPersonSnapshotWrite(
      {
        person_id: PERSON_ID,
        pass_kind: "summary",
        card_state: { relationship_to_me: "manager" },
        evidence_pointer_ids: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
        diff_summary: "weekly summary",
        confidence_delta: { relationship_to_me: 0.12 },
      },
      { config: CFG, fetchImpl: fetchMock },
    );
    const init = fetchMock.calls[0].init;
    expect(init.headers.Authorization).toBe("Bearer orb_live_test_snap");
    const sent = JSON.parse(init.body);
    expect(sent.pass_kind).toBe("summary");
    expect(sent.card_state.relationship_to_me).toBe("manager");
    expect(sent.evidence_pointer_ids).toHaveLength(1);
    expect(sent.diff_summary).toBe("weekly summary");
    expect(sent.confidence_delta.relationship_to_me).toBeCloseTo(0.12);
  });

  it("rejects missing person_id locally (no fetch call)", async () => {
    const fetchMock = makeFetch(() => jsonResponse({ ok: true }));
    const r = await orbitPersonSnapshotWrite(
      { pass_kind: "enricher" },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.error).toBeDefined();
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("rejects invalid person_id UUID locally (no fetch call)", async () => {
    const fetchMock = makeFetch(() => jsonResponse({ ok: true }));
    const r = await orbitPersonSnapshotWrite(
      { person_id: "not-a-uuid", pass_kind: "enricher" },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.error).toBeDefined();
    expect(r.error.code).toBe("INVALID_UUID");
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("rejects invalid pass_kind locally (no fetch call)", async () => {
    const fetchMock = makeFetch(() => jsonResponse({ ok: true }));
    const r = await orbitPersonSnapshotWrite(
      { person_id: PERSON_ID, pass_kind: "bogus" },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.error).toBeDefined();
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("surfaces HTTP errors as {error:{code:...}}", async () => {
    const fetchMock = makeFetch(() =>
      jsonResponse({ error: "person not found" }, { status: 404 }),
    );
    const r = await orbitPersonSnapshotWrite(
      { person_id: PERSON_ID, pass_kind: "enricher" },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.error).toBeDefined();
    expect(r.error.http_status).toBe(404);
  });
});

// =========================================================================
// orbit_person_snapshots_list
// =========================================================================

describe("orbit_person_snapshots_list", () => {
  it("GET target includes /api/v1/person/:id/snapshots (single /api/v1)", async () => {
    const fetchMock = makeFetch(() =>
      jsonResponse({ snapshots: [], total: 0 }),
    );
    await orbitPersonSnapshotsList(
      { person_id: PERSON_ID },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(fetchMock.calls[0].url).toBe(
      `http://100.97.152.84:3047/api/v1/person/${PERSON_ID}/snapshots`,
    );
    expect(fetchMock.calls[0].url).not.toContain("/api/v1/api/v1");
    expect(fetchMock.calls[0].init.method).toBe("GET");
  });

  it("passes limit as a query string when provided", async () => {
    const fetchMock = makeFetch(() =>
      jsonResponse({ snapshots: [], total: 0 }),
    );
    await orbitPersonSnapshotsList(
      { person_id: PERSON_ID, limit: 30 },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(fetchMock.calls[0].url).toBe(
      `http://100.97.152.84:3047/api/v1/person/${PERSON_ID}/snapshots?limit=30`,
    );
  });

  it("returns {snapshots, total} on success", async () => {
    const rows = [
      {
        id: SNAPSHOT_ID,
        person_id: PERSON_ID,
        pass_at: "2026-04-22T00:00:00Z",
        pass_kind: "enricher",
        card_state: {},
        evidence_pointer_ids: [],
        diff_summary: "x",
        confidence_delta: {},
        created_at: "2026-04-22T00:00:00Z",
      },
    ];
    const fetchMock = makeFetch(() =>
      jsonResponse({ snapshots: rows, total: 1 }),
    );
    const r = await orbitPersonSnapshotsList(
      { person_id: PERSON_ID },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.total).toBe(1);
    expect(r.snapshots).toHaveLength(1);
    expect(r.snapshots[0].pass_kind).toBe("enricher");
  });

  it("rejects invalid person_id UUID locally", async () => {
    const fetchMock = makeFetch(() => jsonResponse({ snapshots: [] }));
    const r = await orbitPersonSnapshotsList(
      { person_id: "not-a-uuid" },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.error).toBeDefined();
    expect(r.error.code).toBe("INVALID_UUID");
    expect(fetchMock.calls).toHaveLength(0);
  });
});
