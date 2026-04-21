import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  orbitObservationEmit,
  orbitObservationBulk,
  orbitPersonGet,
  orbitPersonsListEnriched,
} from "../../orbit-cli-plugin/lib/client.mjs";
import { resolveConfig } from "../../orbit-cli-plugin/lib/env.mjs";

// ---------------------------------------------------------------------------
// Helpers: a tiny fetch-mock that records calls and returns scripted responses.
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
  ORBIT_API_KEY: "orb_live_test_abc123",
};

// Pre-resolve the config once; client takes {config} not {env}.
// resolveConfig now returns {ok:true, config:{url,key}} on success — unwrap.
const CFG = resolveConfig(ENV).config;

const UMAYR_ID = "67050b91-5011-4ba6-b230-9a387879717a";

// A canonically-valid observation envelope (interaction kind).
function goodObservation() {
  return {
    observed_at: "2026-04-19T08:30:00.000+00:00",
    observer: "wazowski",
    kind: "interaction",
    evidence_pointer: "wacli://messages/chat=971586783040@s.whatsapp.net",
    confidence: 0.9,
    reasoning: "Umayr and Sanchay exchanged DMs about AI tooling on 2026-04-16.",
    payload: {
      participants: ["Sanchay", "Umayr Sheik"],
      channel: "whatsapp",
      summary: "Regular DM covering AI/tech discussions",
      topic: "tech",
      relationship_context: "close peer",
      connection_context: "mutual AI/ML interest",
      sentiment: "positive",
    },
  };
}

// =========================================================================
// orbit_person_get
// =========================================================================

describe("orbit_person_get", () => {
  it("happy path returns {card:{...}}", async () => {
    const fetchMock = makeFetch(() =>
      jsonResponse({ card: { person_id: UMAYR_ID, name: "Umayr Sheik" } }),
    );
    const r = await orbitPersonGet(
      { person_id: UMAYR_ID },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.card).toBeDefined();
    expect(r.card.name).toBe("Umayr Sheik");
  });

  // THE DOUBLE-PREPEND GUARD. This is the canonical bug for this plugin;
  // the base is a bare host and the client must append /api/v1 exactly once.
  it("does NOT double-prepend /api/v1", async () => {
    const fetchMock = makeFetch(() =>
      jsonResponse({ card: { person_id: UMAYR_ID } }),
    );
    await orbitPersonGet(
      { person_id: UMAYR_ID },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(fetchMock.calls).toHaveLength(1);
    const calledUrl = fetchMock.calls[0].url;
    expect(calledUrl).toBe(
      `http://100.97.152.84:3047/api/v1/person/${UMAYR_ID}/card`,
    );
    expect(calledUrl).not.toContain("/api/v1/api/v1");
  });

  it("sends Authorization: Bearer <key> header", async () => {
    const fetchMock = makeFetch(() => jsonResponse({ card: {} }));
    await orbitPersonGet(
      { person_id: UMAYR_ID },
      { config: CFG, fetchImpl: fetchMock },
    );
    const hdrs = fetchMock.calls[0].init.headers;
    expect(hdrs.Authorization).toBe("Bearer orb_live_test_abc123");
  });

  it("rejects non-UUID person_id locally (no fetch call)", async () => {
    const fetchMock = makeFetch(() => jsonResponse({ card: {} }));
    const r = await orbitPersonGet(
      { person_id: "not-a-uuid" },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.error).toBeDefined();
    expect(r.error.code).toBe("INVALID_UUID");
    expect(r.error.message).toMatch(/not a valid UUID/);
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("returns {error} on 404", async () => {
    const fetchMock = makeFetch(() =>
      jsonResponse({ error: "person not found" }, { status: 404 }),
    );
    const r = await orbitPersonGet(
      { person_id: UMAYR_ID },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.error).toBeDefined();
    expect(r.error.code).toBe("NOT_FOUND");
    expect(r.error.http_status).toBe(404);
  });

  it("preserves trailing-slash env vars without doubling (resolveConfig strips, path joins cleanly)", async () => {
    const fetchMock = makeFetch(() => jsonResponse({ card: {} }));
    const config = resolveConfig({
      ORBIT_API_BASE: "http://100.97.152.84:3047/",
      ORBIT_API_KEY: ENV.ORBIT_API_KEY,
    }).config;
    await orbitPersonGet(
      { person_id: UMAYR_ID },
      { config, fetchImpl: fetchMock },
    );
    expect(fetchMock.calls[0].url).toBe(
      `http://100.97.152.84:3047/api/v1/person/${UMAYR_ID}/card`,
    );
  });
});

// =========================================================================
// orbit_observation_emit
// =========================================================================

describe("orbit_observation_emit", () => {
  it("happy path posts and returns counts", async () => {
    const fetchMock = makeFetch(() =>
      jsonResponse({ ok: true, accepted: 1, inserted: 1, deduped: 0 }),
    );
    const r = await orbitObservationEmit(
      { observation: goodObservation() },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.ok).toBe(true);
    expect(r.accepted).toBe(1);
    expect(r.inserted).toBe(1);
    expect(r.deduped).toBe(0);
  });

  it("POST target is ORBIT_API_BASE + /api/v1/observations", async () => {
    const fetchMock = makeFetch(() =>
      jsonResponse({ ok: true, accepted: 1, inserted: 1, deduped: 0 }),
    );
    await orbitObservationEmit(
      { observation: goodObservation() },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(fetchMock.calls[0].url).toBe(
      "http://100.97.152.84:3047/api/v1/observations",
    );
    expect(fetchMock.calls[0].init.method).toBe("POST");
  });

  it("wraps the observation in an array before posting", async () => {
    const fetchMock = makeFetch(() =>
      jsonResponse({ ok: true, accepted: 1, inserted: 1, deduped: 0 }),
    );
    await orbitObservationEmit(
      { observation: goodObservation() },
      { config: CFG, fetchImpl: fetchMock },
    );
    const body = JSON.parse(fetchMock.calls[0].init.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
  });

  it("sends Authorization: Bearer header", async () => {
    const fetchMock = makeFetch(() =>
      jsonResponse({ ok: true, accepted: 1, inserted: 1, deduped: 0 }),
    );
    await orbitObservationEmit(
      { observation: goodObservation() },
      { config: CFG, fetchImpl: fetchMock },
    );
    const hdrs = fetchMock.calls[0].init.headers;
    expect(hdrs.Authorization).toBe("Bearer orb_live_test_abc123");
    expect(hdrs["Content-Type"]).toBe("application/json");
  });

  it("rejects array input (push to bulk) without calling fetch", async () => {
    const fetchMock = makeFetch(() => jsonResponse({}));
    const r = await orbitObservationEmit(
      { observation: [goodObservation(), goodObservation()] },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.error).toBeDefined();
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(r.error.suggestion).toMatch(/orbit_observation_bulk/);
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("fail-fasts invalid observation locally (no fetch)", async () => {
    const fetchMock = makeFetch(() => jsonResponse({}));
    const bad = { ...goodObservation(), kind: "not-a-kind" };
    const r = await orbitObservationEmit(
      { observation: bad },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.error).toBeDefined();
    expect(r.error.code).toBe("VALIDATION_FAILED");
    expect(Array.isArray(r.error.details)).toBe(true);
    expect(r.error.details.length).toBeGreaterThan(0);
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("bubbles HTTP 400 with body_preview", async () => {
    const fetchMock = makeFetch(() =>
      jsonResponse(
        { error: "invalid batch", details: [{ path: "payload.topic" }] },
        { status: 400 },
      ),
    );
    const r = await orbitObservationEmit(
      { observation: goodObservation() },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.error).toBeDefined();
    expect(r.error.code).toBe("BAD_REQUEST");
    expect(r.error.http_status).toBe(400);
    expect(r.error.body_preview).toMatch(/invalid batch/);
  });
});

// =========================================================================
// orbit_observation_bulk
// =========================================================================

describe("orbit_observation_bulk", () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "orbit-cli-bulk-"));
  });

  function writeNdjson(filename, lines) {
    const filePath = join(tmpDir, filename);
    writeFileSync(filePath, lines.map((o) => JSON.stringify(o)).join("\n"));
    return filePath;
  }

  it("chunks 250 lines into 3 batches (100+100+50)", async () => {
    const lines = Array.from({ length: 250 }, () => goodObservation());
    const filePath = writeNdjson("250.ndjson", lines);

    const batchSizes = [];
    const fetchMock = makeFetch((url, init) => {
      const body = JSON.parse(init.body);
      batchSizes.push(body.length);
      return jsonResponse({
        ok: true,
        accepted: body.length,
        inserted: body.length,
        deduped: 0,
      });
    });

    const r = await orbitObservationBulk(
      { file_path: filePath },
      { config: CFG, fetchImpl: fetchMock },
    );

    expect(fetchMock.calls).toHaveLength(3);
    expect(batchSizes).toEqual([100, 100, 50]);
    expect(r.total_lines).toBe(250);
    expect(r.batches_posted).toBe(3);
    expect(r.total_inserted).toBe(250);
    expect(r.failed_batches).toHaveLength(0);
  });

  it("empty file returns EMPTY_FILE error and never calls fetch", async () => {
    const filePath = join(tmpDir, "empty.ndjson");
    writeFileSync(filePath, "");

    const fetchMock = makeFetch(() => {
      throw new Error("fetch should not be called for empty file");
    });

    const r = await orbitObservationBulk(
      { file_path: filePath },
      { config: CFG, fetchImpl: fetchMock },
    );

    expect(fetchMock.calls).toHaveLength(0);
    expect(r.error).toBeDefined();
    expect(r.error.code).toBe("EMPTY_FILE");
    expect(r.error.suggestion).toBeDefined();
  });

  it("partial failure: 2nd batch 500s → failed_batches has 1 entry, 1st and 3rd succeed", async () => {
    const lines = Array.from({ length: 250 }, () => goodObservation());
    const filePath = writeNdjson("250-partial.ndjson", lines);

    const fetchMock = makeFetch((url, init, callIdx) => {
      const body = JSON.parse(init.body);
      if (callIdx === 1) {
        return jsonResponse(
          { error: "write failed" },
          { status: 500 },
        );
      }
      return jsonResponse({
        ok: true,
        accepted: body.length,
        inserted: body.length,
        deduped: 0,
      });
    });

    const r = await orbitObservationBulk(
      { file_path: filePath },
      { config: CFG, fetchImpl: fetchMock },
    );

    expect(fetchMock.calls).toHaveLength(3);
    expect(r.batches_posted).toBe(3);
    expect(r.failed_batches).toHaveLength(1);
    expect(r.failed_batches[0].batch_index).toBe(1);
    expect(r.failed_batches[0].http_status).toBe(500);
    expect(r.failed_batches[0].error.code).toBe("SERVER_ERROR");
    // 500s do NOT trigger per-observation isolation — whole-batch failure.
    expect(r.failed_batches[0].failed_observations).toHaveLength(0);
    // 1st (100) + 3rd (50) succeeded.
    expect(r.total_inserted).toBe(150);
  });

  it("skips blank lines without counting them", async () => {
    const filePath = join(tmpDir, "blanks.ndjson");
    writeFileSync(
      filePath,
      [
        JSON.stringify(goodObservation()),
        "",
        "   ",
        JSON.stringify(goodObservation()),
      ].join("\n"),
    );

    const fetchMock = makeFetch(() =>
      jsonResponse({ ok: true, accepted: 2, inserted: 2, deduped: 0 }),
    );

    const r = await orbitObservationBulk(
      { file_path: filePath },
      { config: CFG, fetchImpl: fetchMock },
    );

    expect(r.total_lines).toBe(2);
    expect(r.batches_posted).toBe(1);
    expect(r.total_inserted).toBe(2);
  });

  it("records invalid JSON lines as failed_batches entries, continues", async () => {
    const filePath = join(tmpDir, "bad-json.ndjson");
    writeFileSync(
      filePath,
      [
        JSON.stringify(goodObservation()),
        "{not-json",
        JSON.stringify(goodObservation()),
      ].join("\n"),
    );

    const fetchMock = makeFetch((url, init) => {
      const body = JSON.parse(init.body);
      return jsonResponse({
        ok: true,
        accepted: body.length,
        inserted: body.length,
        deduped: 0,
      });
    });

    const r = await orbitObservationBulk(
      { file_path: filePath },
      { config: CFG, fetchImpl: fetchMock },
    );

    expect(r.total_lines).toBe(3);
    expect(r.batches_posted).toBe(1);
    expect(r.total_inserted).toBe(2);
    expect(r.failed_batches).toHaveLength(1);
    expect(r.failed_batches[0].error.code).toBe("VALIDATION_FAILED");
    expect(r.failed_batches[0].error.message).toMatch(/json parse/);
    expect(r.failed_batches[0].failed_observations[0].line_number).toBe(2);
  });

  it("missing file returns FILE_NOT_FOUND error", async () => {
    const fetchMock = makeFetch(() => jsonResponse({}));
    const r = await orbitObservationBulk(
      { file_path: "/tmp/does-not-exist-xyz-orbit-cli.ndjson" },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.error).toBeDefined();
    expect(r.error.code).toBe("FILE_NOT_FOUND");
    expect(r.error.message).toMatch(/file not found/);
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("concurrency > 1 rejected in V0", async () => {
    const filePath = writeNdjson("one.ndjson", [goodObservation()]);
    const fetchMock = makeFetch(() => jsonResponse({}));
    const r = await orbitObservationBulk(
      { file_path: filePath, concurrency: 4 },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.error).toBeDefined();
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(r.error.message).toMatch(/concurrency=4 not supported/);
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("bulk Authorization header is present on every batch", async () => {
    const lines = Array.from({ length: 150 }, () => goodObservation());
    const filePath = writeNdjson("150.ndjson", lines);

    const fetchMock = makeFetch((url, init) => {
      const body = JSON.parse(init.body);
      return jsonResponse({
        ok: true,
        accepted: body.length,
        inserted: body.length,
        deduped: 0,
      });
    });

    await orbitObservationBulk(
      { file_path: filePath },
      { config: CFG, fetchImpl: fetchMock },
    );

    expect(fetchMock.calls).toHaveLength(2);
    for (const c of fetchMock.calls) {
      expect(c.init.headers.Authorization).toBe("Bearer orb_live_test_abc123");
    }
  });

  it("bulk URL does NOT double-prepend /api/v1", async () => {
    const filePath = writeNdjson("one.ndjson", [goodObservation()]);
    const fetchMock = makeFetch(() =>
      jsonResponse({ ok: true, accepted: 1, inserted: 1, deduped: 0 }),
    );
    await orbitObservationBulk(
      { file_path: filePath },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(fetchMock.calls[0].url).toBe(
      "http://100.97.152.84:3047/api/v1/observations",
    );
    expect(fetchMock.calls[0].url).not.toContain("/api/v1/api/v1");
  });
});

// =========================================================================
// Env / plumbing
// =========================================================================

describe("env plumbing", () => {
  it("missing ORBIT_API_BASE returns an INVALID_INPUT envelope (does not throw)", () => {
    const r = resolveConfig({ ORBIT_API_KEY: "orb_live_x" });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(r.error.message).toMatch(/ORBIT_API_BASE/);
    expect(r.error.suggestion).toBeDefined();
  });

  it("missing ORBIT_API_KEY returns an INVALID_INPUT envelope (does not throw)", () => {
    const r = resolveConfig({ ORBIT_API_BASE: "http://x" });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(r.error.message).toMatch(/ORBIT_API_KEY/);
  });

  it("both missing — surfaces BASE first (precedence)", () => {
    const r = resolveConfig({});
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(r.error.message).toMatch(/ORBIT_API_BASE/);
  });

  it("rejects ORBIT_API_BASE that contains /api/v<N> (guards against stale configs)", () => {
    const r = resolveConfig({
      ORBIT_API_BASE: "http://x/api/v1",
      ORBIT_API_KEY: "orb_live_y",
    });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(r.error.message).toMatch(/must not include/);
  });

  it("resolveConfig strips trailing slashes on success", () => {
    const r = resolveConfig({
      ORBIT_API_BASE: "http://x////",
      ORBIT_API_KEY: "orb_live_y",
    });
    expect(r.ok).toBe(true);
    expect(r.config.url).toBe("http://x");
    expect(r.config.key).toBe("orb_live_y");
  });

  // Simulates the envelope wrapping at index.js — when resolveConfig returns
  // !ok, no network call is made and the envelope surfaces the INVALID_INPUT
  // error. This guards against any future refactor that regresses to throwing.
  it("when env missing, the execute() wrapper returns envelope error and never calls fetch", async () => {
    const fetchMock = makeFetch(() => jsonResponse({ card: {} }));
    // Simulate the wrapper at orbit-cli-plugin/index.js — pre-flight config
    // check must short-circuit before any client call.
    const cfg = resolveConfig({});
    let result;
    if (!cfg.ok) {
      result = { error: cfg.error };
    } else {
      result = await orbitPersonGet(
        { person_id: UMAYR_ID },
        { config: cfg.config, fetchImpl: fetchMock },
      );
    }
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe("INVALID_INPUT");
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("when env missing, same short-circuit applies to orbit_observation_emit", async () => {
    const fetchMock = makeFetch(() => jsonResponse({ ok: true }));
    const cfg = resolveConfig({ ORBIT_API_KEY: "orb_live_x" }); // URL missing
    let result;
    if (!cfg.ok) {
      result = { error: cfg.error };
    } else {
      result = await orbitObservationEmit(
        { observation: goodObservation() },
        { config: cfg.config, fetchImpl: fetchMock },
      );
    }
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe("INVALID_INPUT");
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("when env missing, same short-circuit applies to orbit_observation_bulk", async () => {
    const fetchMock = makeFetch(() => jsonResponse({ ok: true }));
    const cfg = resolveConfig({ ORBIT_API_BASE: "http://x" }); // KEY missing
    let result;
    if (!cfg.ok) {
      result = { error: cfg.error };
    } else {
      result = await orbitObservationBulk(
        { file_path: "/tmp/doesnt-matter.ndjson" },
        { config: cfg.config, fetchImpl: fetchMock },
      );
    }
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe("INVALID_INPUT");
    expect(fetchMock.calls).toHaveLength(0);
  });
});

// =========================================================================
// Error-code taxonomy — at least one test per canonical code.
// =========================================================================

describe("error codes", () => {
  describe("every error has {code, message, suggestion}", () => {
    it("VALIDATION_FAILED includes details[] with field+reason", async () => {
      const bad = { ...goodObservation(), confidence: 5 }; // out of [0,1]
      const fetchMock = makeFetch(() => jsonResponse({}));
      const r = await orbitObservationEmit(
        { observation: bad },
        { config: CFG, fetchImpl: fetchMock },
      );
      expect(r.error.code).toBe("VALIDATION_FAILED");
      expect(r.error.suggestion).toBeDefined();
      expect(Array.isArray(r.error.details)).toBe(true);
      expect(r.error.details[0].field).toBe("confidence");
      expect(r.error.details[0].reason).toBeDefined();
      expect(fetchMock.calls).toHaveLength(0);
    });

    it("AUTH_FAILED on 401", async () => {
      const fetchMock = makeFetch(() =>
        jsonResponse({ error: "bad token" }, { status: 401 }),
      );
      const r = await orbitPersonGet(
        { person_id: UMAYR_ID },
        { config: CFG, fetchImpl: fetchMock },
      );
      expect(r.error.code).toBe("AUTH_FAILED");
      expect(r.error.suggestion).toMatch(/ORBIT_API_KEY/);
    });

    it("AUTH_FAILED on 403", async () => {
      const fetchMock = makeFetch(() =>
        jsonResponse({ error: "forbidden" }, { status: 403 }),
      );
      const r = await orbitPersonGet(
        { person_id: UMAYR_ID },
        { config: CFG, fetchImpl: fetchMock },
      );
      expect(r.error.code).toBe("AUTH_FAILED");
    });

    it("NOT_FOUND on 404", async () => {
      const fetchMock = makeFetch(() =>
        jsonResponse({ error: "person not found" }, { status: 404 }),
      );
      const r = await orbitPersonGet(
        { person_id: UMAYR_ID },
        { config: CFG, fetchImpl: fetchMock },
      );
      expect(r.error.code).toBe("NOT_FOUND");
      expect(r.error.suggestion).toMatch(/resolve/i);
    });

    it("RATE_LIMITED on 429", async () => {
      const fetchMock = makeFetch(() =>
        jsonResponse({ error: "slow down" }, { status: 429 }),
      );
      const r = await orbitObservationEmit(
        { observation: goodObservation() },
        { config: CFG, fetchImpl: fetchMock },
      );
      expect(r.error.code).toBe("RATE_LIMITED");
      expect(r.error.suggestion).toMatch(/back off|60s/i);
    });

    it("SERVER_ERROR on 500", async () => {
      const fetchMock = makeFetch(() =>
        jsonResponse({ error: "boom" }, { status: 500 }),
      );
      const r = await orbitObservationEmit(
        { observation: goodObservation() },
        { config: CFG, fetchImpl: fetchMock },
      );
      expect(r.error.code).toBe("SERVER_ERROR");
      expect(r.error.suggestion).toMatch(/logs/i);
    });

    it("SERVER_ERROR on 503", async () => {
      const fetchMock = makeFetch(() =>
        jsonResponse({ error: "unavailable" }, { status: 503 }),
      );
      const r = await orbitObservationEmit(
        { observation: goodObservation() },
        { config: CFG, fetchImpl: fetchMock },
      );
      expect(r.error.code).toBe("SERVER_ERROR");
    });

    it("NETWORK_ERROR when fetch throws (ECONNREFUSED)", async () => {
      const fetchMock = makeFetch(() => {
        throw Object.assign(new Error("connect ECONNREFUSED 100.97.152.84:3047"), {
          code: "ECONNREFUSED",
        });
      });
      const r = await orbitObservationEmit(
        { observation: goodObservation() },
        { config: CFG, fetchImpl: fetchMock },
      );
      expect(r.error.code).toBe("NETWORK_ERROR");
      expect(r.error.message).toMatch(/ECONNREFUSED/);
      expect(r.error.suggestion).toMatch(/connectivity|Tailscale/i);
    });

    it("NETWORK_ERROR on GET side too (orbit_person_get)", async () => {
      const fetchMock = makeFetch(() => {
        throw new Error("ENOTFOUND orbit.local");
      });
      const r = await orbitPersonGet(
        { person_id: UMAYR_ID },
        { config: CFG, fetchImpl: fetchMock },
      );
      expect(r.error.code).toBe("NETWORK_ERROR");
    });

    it("INVALID_UUID on malformed person_id", async () => {
      const fetchMock = makeFetch(() => jsonResponse({}));
      const r = await orbitPersonGet(
        { person_id: "abc-123" },
        { config: CFG, fetchImpl: fetchMock },
      );
      expect(r.error.code).toBe("INVALID_UUID");
      expect(r.error.suggestion).toMatch(/36-character|hex/i);
      expect(fetchMock.calls).toHaveLength(0);
    });

    it("FILE_NOT_FOUND on missing bulk file", async () => {
      const fetchMock = makeFetch(() => jsonResponse({}));
      const r = await orbitObservationBulk(
        { file_path: "/tmp/orbit-no-such-file-xyz.ndjson" },
        { config: CFG, fetchImpl: fetchMock },
      );
      expect(r.error.code).toBe("FILE_NOT_FOUND");
      expect(r.error.suggestion).toMatch(/claw|gateway/i);
    });

    it("EMPTY_FILE on zero-line bulk file", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "orbit-cli-err-"));
      const fp = join(tmp, "empty.ndjson");
      writeFileSync(fp, "   \n\n   \n");
      const fetchMock = makeFetch(() => jsonResponse({}));
      const r = await orbitObservationBulk(
        { file_path: fp },
        { config: CFG, fetchImpl: fetchMock },
      );
      expect(r.error.code).toBe("EMPTY_FILE");
      expect(fetchMock.calls).toHaveLength(0);
    });

    // MAX_BATCH_EXCEEDED is enforced by server (batch of 100 is the chunking
    // boundary; emit() is single-obs). We exercise the code-path via a
    // server-returned 400 to confirm BAD_REQUEST propagates with a body_preview
    // so the agent can see the server's explanation.
    it("BAD_REQUEST from server has body_preview preserved", async () => {
      const fetchMock = makeFetch(() =>
        jsonResponse(
          {
            error: "batch exceeds MAX_BATCH=100",
            code: "MAX_BATCH_EXCEEDED",
          },
          { status: 400 },
        ),
      );
      const r = await orbitObservationEmit(
        { observation: goodObservation() },
        { config: CFG, fetchImpl: fetchMock },
      );
      expect(r.error.code).toBe("BAD_REQUEST");
      expect(r.error.body_preview).toMatch(/MAX_BATCH/);
    });
  });
});

// =========================================================================
// orbit_observation_bulk — per-observation failure isolation on 400
// =========================================================================

describe("orbit_observation_bulk per-observation isolation", () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "orbit-cli-iso-"));
  });

  function writeNdjson(filename, lines) {
    const filePath = join(tmpDir, filename);
    writeFileSync(filePath, lines.map((o) => JSON.stringify(o)).join("\n"));
    return filePath;
  }

  it("isolates failing observations: 100 valid + 3 invalid → 3 failed_observations with correct line_numbers", async () => {
    // Construct 103 lines: 100 valid + 3 invalid. Invalid lines are still
    // parseable JSON (so the CLI's local JSON.parse succeeds) but shape is
    // wrong — simulate the server catching them.
    const lines = [];
    for (let i = 0; i < 100; i += 1) lines.push(goodObservation());
    // Shove 3 shape-bad observations at positions 42, 77, 101 (1-indexed lines).
    // We'll mark them by adding a sentinel the mock can detect.
    const badIndices = [41, 76, 100]; // 0-indexed
    for (const bi of badIndices) {
      lines.splice(bi, 0, {
        ...goodObservation(),
        __bad_sentinel: true,
      });
    }
    const filePath = writeNdjson("iso.ndjson", lines);
    // Splices happen sequentially into the same array; each splice inserts
    // at its given index, pushing trailing items right. So the bad lines
    // end up at 0-indexed positions 41, 76, 100 → 1-indexed lines 42, 77, 101.
    const expectedLineNumbers = [42, 77, 101];

    // Mock: batch POST returns 400 if ANY line has the sentinel. Isolated
    // single-line POSTs return 400 only if THAT line has the sentinel.
    const fetchMock = makeFetch((url, init) => {
      const body = JSON.parse(init.body);
      const anyBad = body.some((o) => o?.__bad_sentinel === true);
      if (anyBad) {
        return jsonResponse(
          { error: "line rejected", details: "bad shape" },
          { status: 400 },
        );
      }
      return jsonResponse({
        ok: true,
        accepted: body.length,
        inserted: body.length,
        deduped: 0,
      });
    });

    const r = await orbitObservationBulk(
      { file_path: filePath },
      { config: CFG, fetchImpl: fetchMock },
    );

    // 103 lines total, two batches (100 + 3). First batch has the first
    // two bad lines so it 400s and we isolate all 100. Second batch has
    // the third bad line so it 400s and we isolate 3.
    expect(r.total_lines).toBe(103);
    expect(r.batches_posted).toBe(2);

    // All failed batches are batches that 400'd.
    const failed = r.failed_batches;
    expect(failed.length).toBeGreaterThanOrEqual(1);

    // Flatten per-obs failures across all failed batches.
    const allFailed = failed.flatMap((b) => b.failed_observations ?? []);
    expect(allFailed).toHaveLength(3);
    expect(allFailed.map((f) => f.line_number).sort((a, b) => a - b)).toEqual(
      expectedLineNumbers.sort((a, b) => a - b),
    );
    for (const f of allFailed) {
      expect(f.observation_snippet).toMatch(/__bad_sentinel/);
      expect(f.error.code).toBe("BAD_REQUEST");
    }
  });

  it("500 does NOT trigger per-observation isolation (no retry amplification)", async () => {
    const lines = Array.from({ length: 50 }, () => goodObservation());
    const filePath = writeNdjson("500-batch.ndjson", lines);
    let callCount = 0;
    const fetchMock = makeFetch(() => {
      callCount += 1;
      return jsonResponse({ error: "down" }, { status: 500 });
    });
    const r = await orbitObservationBulk(
      { file_path: filePath },
      { config: CFG, fetchImpl: fetchMock },
    );
    // One batch POST → one 500 → no isolation retries.
    expect(callCount).toBe(1);
    expect(r.failed_batches).toHaveLength(1);
    expect(r.failed_batches[0].http_status).toBe(500);
    expect(r.failed_batches[0].error.code).toBe("SERVER_ERROR");
    expect(r.failed_batches[0].failed_observations).toHaveLength(0);
  });

  it("failed_batches entries carry start_line + end_line for humans", async () => {
    const lines = Array.from({ length: 150 }, () => goodObservation());
    const filePath = writeNdjson("150.ndjson", lines);
    const fetchMock = makeFetch((url, init, callIdx) => {
      const body = JSON.parse(init.body);
      if (callIdx === 0) {
        return jsonResponse({ error: "fail" }, { status: 500 });
      }
      return jsonResponse({
        ok: true,
        accepted: body.length,
        inserted: body.length,
        deduped: 0,
      });
    });
    const r = await orbitObservationBulk(
      { file_path: filePath },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.failed_batches[0].start_line).toBe(1);
    expect(r.failed_batches[0].end_line).toBe(100);
  });

  it("network error in one batch: whole batch fails, other batches continue", async () => {
    const lines = Array.from({ length: 250 }, () => goodObservation());
    const filePath = writeNdjson("net.ndjson", lines);
    const fetchMock = makeFetch((url, init, callIdx) => {
      if (callIdx === 1) {
        throw new Error("ECONNRESET");
      }
      const body = JSON.parse(init.body);
      return jsonResponse({
        ok: true,
        accepted: body.length,
        inserted: body.length,
        deduped: 0,
      });
    });
    const r = await orbitObservationBulk(
      { file_path: filePath },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.batches_posted).toBe(3);
    expect(r.failed_batches).toHaveLength(1);
    expect(r.failed_batches[0].error.code).toBe("NETWORK_ERROR");
    expect(r.failed_batches[0].failed_observations).toHaveLength(0);
    expect(r.total_inserted).toBe(150); // batch 0 (100) + batch 2 (50)
  });
});

// =========================================================================
// Dry-run mode (emit + bulk)
// =========================================================================

describe("dry-run mode", () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "orbit-cli-dry-"));
  });

  function writeNdjson(filename, lines) {
    const filePath = join(tmpDir, filename);
    writeFileSync(filePath, lines.map((o) => JSON.stringify(o)).join("\n"));
    return filePath;
  }

  it("emit dry-run: valid observation returns would_insert:1 and does NOT call fetch", async () => {
    const fetchMock = makeFetch(() => {
      throw new Error("fetch MUST NOT be called in dry-run");
    });
    const r = await orbitObservationEmit(
      { observation: goodObservation(), dry_run: true },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.ok).toBe(true);
    expect(r.dry_run).toBe(true);
    expect(r.would_insert).toBe(1);
    expect(r.validation.passed).toBe(true);
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("emit dry-run: invalid observation returns VALIDATION_FAILED, does NOT call fetch", async () => {
    const fetchMock = makeFetch(() => {
      throw new Error("fetch MUST NOT be called in dry-run");
    });
    const bad = { ...goodObservation(), observer: "not-a-known-observer" };
    const r = await orbitObservationEmit(
      { observation: bad, dry_run: true },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.error).toBeDefined();
    expect(r.error.code).toBe("VALIDATION_FAILED");
    expect(r.error.details[0].field).toBe("observer");
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("bulk dry-run: 250-line mix (247 valid + 3 invalid) → would_insert_count=247, would_fail=3, no fetch", async () => {
    const lines = [];
    for (let i = 0; i < 247; i += 1) lines.push(goodObservation());
    // Inject 3 invalid rows at well-known line positions.
    lines.splice(5, 0, { ...goodObservation(), confidence: 99 }); // line 6
    lines.splice(100, 0, { ...goodObservation(), kind: "not-real" }); // line 101
    lines.splice(200, 0, { ...goodObservation(), observer: "nope" }); // line 201
    const filePath = writeNdjson("dry.ndjson", lines);

    const fetchMock = makeFetch(() => {
      throw new Error("fetch MUST NOT be called in dry-run");
    });

    const r = await orbitObservationBulk(
      { file_path: filePath, dry_run: true },
      { config: CFG, fetchImpl: fetchMock },
    );

    expect(r.ok).toBe(true);
    expect(r.dry_run).toBe(true);
    expect(r.total_lines).toBe(250);
    expect(r.would_insert_count).toBe(247);
    expect(r.would_fail).toHaveLength(3);
    expect(r.would_fail.map((f) => f.line_number).sort((a, b) => a - b)).toEqual(
      [6, 101, 201],
    );
    for (const f of r.would_fail) {
      expect(f.error.code).toBe("VALIDATION_FAILED");
    }
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("bulk dry-run flags JSON-parse failures alongside schema failures", async () => {
    const filePath = join(tmpDir, "bad-json.ndjson");
    writeFileSync(
      filePath,
      [
        JSON.stringify(goodObservation()),
        "{this is not valid json",
        JSON.stringify(goodObservation()),
      ].join("\n"),
    );
    const fetchMock = makeFetch(() => {
      throw new Error("fetch MUST NOT be called in dry-run");
    });
    const r = await orbitObservationBulk(
      { file_path: filePath, dry_run: true },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.dry_run).toBe(true);
    expect(r.would_insert_count).toBe(2);
    expect(r.would_fail).toHaveLength(1);
    expect(r.would_fail[0].line_number).toBe(2);
    expect(r.would_fail[0].error.code).toBe("VALIDATION_FAILED");
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("bulk dry-run still reports FILE_NOT_FOUND (fs check runs before mode branch)", async () => {
    const fetchMock = makeFetch(() => jsonResponse({}));
    const r = await orbitObservationBulk(
      { file_path: "/tmp/orbit-cli-dry-missing.ndjson", dry_run: true },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.error.code).toBe("FILE_NOT_FOUND");
  });

  it("bulk dry-run on empty file returns EMPTY_FILE", async () => {
    const fp = join(tmpDir, "empty.ndjson");
    writeFileSync(fp, "\n\n");
    const fetchMock = makeFetch(() => jsonResponse({}));
    const r = await orbitObservationBulk(
      { file_path: fp, dry_run: true },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.error.code).toBe("EMPTY_FILE");
  });
});

// =========================================================================
// orbit_persons_list_enriched (C2)
// =========================================================================

describe("orbit_persons_list_enriched", () => {
  it("happy path: single page returns {persons[]}", async () => {
    const fetchMock = makeFetch(() =>
      jsonResponse({
        persons: [
          { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Umayr", category: "team" },
        ],
        next_cursor: null,
      }),
    );
    const r = await orbitPersonsListEnriched(
      {},
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(Array.isArray(r.persons)).toBe(true);
    expect(r.persons).toHaveLength(1);
    expect(r.persons[0].name).toBe("Umayr");
    expect(fetchMock.calls).toHaveLength(1);
  });

  it("pagination concatenates pages", async () => {
    let callIdx = 0;
    const fetchMock = makeFetch(() => {
      callIdx += 1;
      if (callIdx === 1) {
        return jsonResponse({
          persons: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", name: "A" }],
          next_cursor: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
        });
      }
      return jsonResponse({
        persons: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", name: "B" }],
        next_cursor: null,
      });
    });
    const r = await orbitPersonsListEnriched(
      {},
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.persons).toHaveLength(2);
    expect(r.persons.map((p) => p.name)).toEqual(["A", "B"]);
    expect(fetchMock.calls).toHaveLength(2);
  });

  it("401 returns AUTH_FAILED envelope", async () => {
    const fetchMock = makeFetch(() =>
      jsonResponse({ error: "bad token" }, { status: 401 }),
    );
    const r = await orbitPersonsListEnriched(
      {},
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.error).toBeDefined();
    expect(r.error.code).toBe("AUTH_FAILED");
  });

  it("circuit breaker at 10 pages flags a warning and returns partial", async () => {
    const fetchMock = makeFetch(() =>
      jsonResponse({
        persons: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "X" }],
        next_cursor: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab", // never terminates
      }),
    );
    const r = await orbitPersonsListEnriched(
      {},
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(fetchMock.calls).toHaveLength(10);
    expect(r.persons).toHaveLength(10);
    expect(Array.isArray(r.warnings)).toBe(true);
    expect(r.warnings[0].code).toBe("PAGINATION_CIRCUIT_BREAK");
  });

  it("adds Authorization + cursor query param when provided", async () => {
    const fetchMock = makeFetch(() =>
      jsonResponse({ persons: [], next_cursor: null }),
    );
    await orbitPersonsListEnriched(
      { cursor: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", limit: 10 },
      { config: CFG, fetchImpl: fetchMock },
    );
    const urlCalled = fetchMock.calls[0].url;
    expect(urlCalled).toContain("/persons/enriched");
    expect(urlCalled).toContain("cursor=");
    expect(urlCalled).toContain("limit=10");
    expect(fetchMock.calls[0].init.headers.Authorization).toBe(
      "Bearer orb_live_test_abc123",
    );
  });
});
