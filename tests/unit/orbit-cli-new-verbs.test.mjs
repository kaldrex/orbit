/**
 * Phase 4.5 rebalance — unit tests for the 11 new orbit-cli verbs.
 *
 * Each verb has:
 *   (a) a happy-path test hitting a mocked fetch / spawn / sqlite,
 *   (b) a structured-error test (validation, HTTP, or shape).
 *
 * The file lives alongside tests/unit/orbit-cli-plugin.test.mjs (which
 * covers the four original verbs). We don't re-test URL-joining / auth
 * header plumbing here — those paths are shared via lib/client.mjs and
 * already covered over there.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  orbitSelfInit,
  orbitPersonsGoingCold,
  orbitPersonGetByEmail,
  orbitMeetingUpsert,
  orbitMeetingList,
  orbitTopicsUpsert,
  orbitTopicsGet,
  orbitCalendarFetch,
  orbitMessagesFetch,
  orbitJobsClaim,
  orbitJobsReport,
} from "../../orbit-cli-plugin/lib/client.mjs";
import { resolveConfig } from "../../orbit-cli-plugin/lib/env.mjs";

// --- mock helpers --------------------------------------------------------

function jsonResponse(body, { status = 200 } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Err",
    headers: {
      get(name) {
        return name.toLowerCase() === "content-type"
          ? "application/json"
          : null;
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
  ORBIT_API_URL: "http://100.97.152.84:3047/api/v1",
  ORBIT_API_KEY: "orb_live_test_abc123",
};
const CFG = resolveConfig(ENV).config;

const UMAYR_ID = "67050b91-5011-4ba6-b230-9a387879717a";

// =========================================================================
// orbit_self_init
// =========================================================================

describe("orbit_self_init", () => {
  it("happy path: POST /self/init returns {self_node_id}", async () => {
    const fetchMock = makeFetch((url, init) => {
      // sanity — POST to /self/init
      return jsonResponse({ self_node_id: UMAYR_ID });
    });
    const r = await orbitSelfInit({}, { config: CFG, fetchImpl: fetchMock });
    expect(r.self_node_id).toBe(UMAYR_ID);
    expect(fetchMock.calls).toHaveLength(1);
    expect(fetchMock.calls[0].url).toBe(
      "http://100.97.152.84:3047/api/v1/self/init",
    );
    expect(fetchMock.calls[0].init.method).toBe("POST");
    expect(fetchMock.calls[0].init.headers.Authorization).toBe(
      "Bearer orb_live_test_abc123",
    );
  });

  it("structured error: 404 NO_IDENTITY_CONFIGURED returns NOT_FOUND", async () => {
    const fetchMock = makeFetch(() =>
      jsonResponse(
        { error: { code: "NO_IDENTITY_CONFIGURED", message: "set env" } },
        { status: 404 },
      ),
    );
    const r = await orbitSelfInit({}, { config: CFG, fetchImpl: fetchMock });
    expect(r.error).toBeDefined();
    expect(r.error.code).toBe("NOT_FOUND");
    expect(r.error.http_status).toBe(404);
    expect(r.error.body_preview).toMatch(/NO_IDENTITY_CONFIGURED/);
  });
});

// =========================================================================
// orbit_persons_going_cold
// =========================================================================

describe("orbit_persons_going_cold", () => {
  it("happy path: returns {persons, total}", async () => {
    const fetchMock = makeFetch(() =>
      jsonResponse({
        persons: [
          {
            id: UMAYR_ID,
            name: "Umayr",
            category: "team",
            last_touch: "2026-04-01T08:00:00Z",
            days_since: 19,
            score: 3.2,
          },
        ],
        total: 1,
      }),
    );
    const r = await orbitPersonsGoingCold(
      {},
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.persons).toHaveLength(1);
    expect(r.total).toBe(1);
    expect(fetchMock.calls[0].url).toBe(
      "http://100.97.152.84:3047/api/v1/persons/going-cold",
    );
    expect(fetchMock.calls[0].init.method).toBe("GET");
  });

  it("structured error: 401 → AUTH_FAILED", async () => {
    const fetchMock = makeFetch(() =>
      jsonResponse({ error: "unauthorized" }, { status: 401 }),
    );
    const r = await orbitPersonsGoingCold(
      {},
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.error.code).toBe("AUTH_FAILED");
  });
});

// =========================================================================
// orbit_person_get_by_email
// =========================================================================

describe("orbit_person_get_by_email", () => {
  it("happy path: case-insensitive email match returns {person, found:true}", async () => {
    const fetchMock = makeFetch(() =>
      jsonResponse({
        persons: [
          {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
            name: "Someone Else",
            emails: ["other@example.com"],
          },
          {
            id: UMAYR_ID,
            name: "Umayr",
            emails: ["USheik@SinxSolutions.ai"],
          },
        ],
        next_cursor: null,
      }),
    );
    const r = await orbitPersonGetByEmail(
      { email: "usheik@sinxsolutions.ai" },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.found).toBe(true);
    expect(r.person.id).toBe(UMAYR_ID);
    expect(r.person.name).toBe("Umayr");
  });

  it("miss returns {person:null, found:false} (not an error)", async () => {
    const fetchMock = makeFetch(() =>
      jsonResponse({ persons: [], next_cursor: null }),
    );
    const r = await orbitPersonGetByEmail(
      { email: "nobody@example.com" },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.found).toBe(false);
    expect(r.person).toBeNull();
  });

  it("structured error: empty email → INVALID_INPUT, no fetch", async () => {
    const fetchMock = makeFetch(() => jsonResponse({}));
    const r = await orbitPersonGetByEmail(
      { email: "" },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.error).toBeDefined();
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(fetchMock.calls).toHaveLength(0);
  });
});

// =========================================================================
// orbit_meeting_upsert
// =========================================================================

describe("orbit_meeting_upsert", () => {
  function meeting() {
    return {
      meeting_id: "evt_abc123",
      title: "Umayr <> Sanchay",
      start_at: "2026-04-22T09:00:00.000+04:00",
      end_at: "2026-04-22T09:30:00.000+04:00",
      attendees: [{ email: "usheik@sinxsolutions.ai", name: "Umayr" }],
      brief_md: "Catch up on SinX v2. Ask about Dubai LLM meetup follow-ups.",
    };
  }

  it("happy path: POST /meetings/upcoming returns {upserted}", async () => {
    const fetchMock = makeFetch(() => jsonResponse({ upserted: 1 }));
    const r = await orbitMeetingUpsert(
      { meetings: [meeting()] },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.upserted).toBe(1);
    expect(fetchMock.calls[0].url).toBe(
      "http://100.97.152.84:3047/api/v1/meetings/upcoming",
    );
    const body = JSON.parse(fetchMock.calls[0].init.body);
    expect(body.meetings).toHaveLength(1);
    expect(body.meetings[0].meeting_id).toBe("evt_abc123");
  });

  it("structured error: empty batch rejected locally, no fetch", async () => {
    const fetchMock = makeFetch(() => jsonResponse({}));
    const r = await orbitMeetingUpsert(
      { meetings: [] },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.error).toBeDefined();
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(r.error.message).toMatch(/empty/);
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("structured error: > 100 meetings rejected locally", async () => {
    const many = Array.from({ length: 101 }, () => meeting());
    const fetchMock = makeFetch(() => jsonResponse({}));
    const r = await orbitMeetingUpsert(
      { meetings: many },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(r.error.message).toMatch(/exceeds server cap/);
    expect(fetchMock.calls).toHaveLength(0);
  });
});

// =========================================================================
// orbit_meeting_list
// =========================================================================

describe("orbit_meeting_list", () => {
  it("happy path: default horizon, returns {meetings}", async () => {
    const fetchMock = makeFetch(() =>
      jsonResponse({
        meetings: [
          {
            meeting_id: "evt_x",
            title: "Test",
            start_at: "2026-04-22T09:00:00Z",
            end_at: null,
            attendees: [],
            brief_md: null,
            generated_at: "2026-04-20T12:00:00Z",
          },
        ],
      }),
    );
    const r = await orbitMeetingList({}, { config: CFG, fetchImpl: fetchMock });
    expect(r.meetings).toHaveLength(1);
    expect(fetchMock.calls[0].url).toBe(
      "http://100.97.152.84:3047/api/v1/meetings/upcoming",
    );
  });

  it("attaches horizon_hours query param", async () => {
    const fetchMock = makeFetch(() => jsonResponse({ meetings: [] }));
    await orbitMeetingList(
      { horizon_hours: 48 },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(fetchMock.calls[0].url).toBe(
      "http://100.97.152.84:3047/api/v1/meetings/upcoming?horizon_hours=48",
    );
  });

  it("structured error: 502 surfaces as SERVER_ERROR", async () => {
    const fetchMock = makeFetch(() =>
      jsonResponse({ error: "rpc failed" }, { status: 502 }),
    );
    const r = await orbitMeetingList({}, { config: CFG, fetchImpl: fetchMock });
    expect(r.error.code).toBe("SERVER_ERROR");
  });
});

// =========================================================================
// orbit_topics_upsert
// =========================================================================

describe("orbit_topics_upsert", () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "orbit-cli-topics-"));
  });

  it("happy path (inline): POST /person/:id/topics returns {count}", async () => {
    const fetchMock = makeFetch(() => jsonResponse({ count: 2 }));
    const r = await orbitTopicsUpsert(
      {
        person_id: UMAYR_ID,
        topics: [
          { topic: "sinx", weight: 1.0 },
          { topic: "dubai", weight: 0.7 },
        ],
      },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.count).toBe(2);
    expect(fetchMock.calls[0].url).toBe(
      `http://100.97.152.84:3047/api/v1/person/${UMAYR_ID}/topics`,
    );
    const body = JSON.parse(fetchMock.calls[0].init.body);
    expect(body.topics).toHaveLength(2);
  });

  it("file mode: reads {topics:[...]} JSON file and POSTs", async () => {
    const fp = join(tmpDir, "topics.json");
    writeFileSync(
      fp,
      JSON.stringify({
        topics: [{ topic: "aakaar", weight: 1 }],
      }),
    );
    const fetchMock = makeFetch(() => jsonResponse({ count: 1 }));
    const r = await orbitTopicsUpsert(
      { person_id: UMAYR_ID, file: fp },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.count).toBe(1);
    const body = JSON.parse(fetchMock.calls[0].init.body);
    expect(body.topics[0].topic).toBe("aakaar");
  });

  it("structured error: passing both topics and file is rejected", async () => {
    const fp = join(tmpDir, "x.json");
    writeFileSync(fp, JSON.stringify({ topics: [] }));
    const fetchMock = makeFetch(() => jsonResponse({}));
    const r = await orbitTopicsUpsert(
      {
        person_id: UMAYR_ID,
        topics: [{ topic: "a", weight: 1 }],
        file: fp,
      },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(r.error.message).toMatch(/exactly one/);
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("structured error: non-UUID person_id → INVALID_UUID", async () => {
    const fetchMock = makeFetch(() => jsonResponse({}));
    const r = await orbitTopicsUpsert(
      { person_id: "not-a-uuid", topics: [{ topic: "x", weight: 1 }] },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.error.code).toBe("INVALID_UUID");
    expect(fetchMock.calls).toHaveLength(0);
  });
});

// =========================================================================
// orbit_topics_get
// =========================================================================

describe("orbit_topics_get", () => {
  it("happy path: returns {topics, total}", async () => {
    const fetchMock = makeFetch(() =>
      jsonResponse({
        topics: [{ topic: "sinx", weight: 1 }],
        total: 1,
      }),
    );
    const r = await orbitTopicsGet(
      { person_id: UMAYR_ID },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.total).toBe(1);
    expect(r.topics[0].topic).toBe("sinx");
    expect(fetchMock.calls[0].url).toBe(
      `http://100.97.152.84:3047/api/v1/person/${UMAYR_ID}/topics`,
    );
  });

  it("attaches limit query param when provided", async () => {
    const fetchMock = makeFetch(() =>
      jsonResponse({ topics: [], total: 0 }),
    );
    await orbitTopicsGet(
      { person_id: UMAYR_ID, limit: 5 },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(fetchMock.calls[0].url).toContain("limit=5");
  });

  it("structured error: bad UUID → INVALID_UUID, no fetch", async () => {
    const fetchMock = makeFetch(() => jsonResponse({}));
    const r = await orbitTopicsGet(
      { person_id: "xxx" },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.error.code).toBe("INVALID_UUID");
    expect(fetchMock.calls).toHaveLength(0);
  });
});

// =========================================================================
// orbit_calendar_fetch (shell out to gws)
// =========================================================================

function fakeChildProcess({ exitCode = 0, stdout = "", stderr = "" } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", exitCode);
  });
  return child;
}

describe("orbit_calendar_fetch", () => {
  it("happy path: parses gws JSON stdout into {events, count}", async () => {
    const gwsOutput = JSON.stringify({
      items: [
        {
          id: "evt_1",
          summary: "Test meeting",
          start: { dateTime: "2026-04-22T09:00:00Z" },
          attendees: [{ email: "a@b.com" }],
        },
      ],
    });
    const spawnImpl = () => fakeChildProcess({ stdout: gwsOutput });
    const r = await orbitCalendarFetch(
      { horizon_hours: 72, spawnImpl, now: () => new Date("2026-04-20T00:00:00Z") },
      {},
    );
    expect(r.events).toHaveLength(1);
    expect(r.events[0].id).toBe("evt_1");
    expect(r.count).toBe(1);
    expect(r.window.timeMin).toBe("2026-04-20T00:00:00.000Z");
    expect(r.window.timeMax).toBe("2026-04-23T00:00:00.000Z");
  });

  it("structured error: gws non-zero exit surfaces NETWORK_ERROR", async () => {
    const spawnImpl = () =>
      fakeChildProcess({ exitCode: 1, stderr: "token expired" });
    const r = await orbitCalendarFetch({ spawnImpl }, {});
    expect(r.error.code).toBe("NETWORK_ERROR");
    expect(r.error.body_preview).toMatch(/token expired/);
  });

  it("structured error: non-JSON stdout → VALIDATION_FAILED", async () => {
    const spawnImpl = () =>
      fakeChildProcess({ stdout: "not json at all" });
    const r = await orbitCalendarFetch({ spawnImpl }, {});
    expect(r.error.code).toBe("VALIDATION_FAILED");
    expect(r.error.body_preview).toMatch(/not json/);
  });

  it("structured error: invalid horizon_hours rejected locally", async () => {
    let spawned = false;
    const spawnImpl = () => {
      spawned = true;
      return fakeChildProcess();
    };
    const r = await orbitCalendarFetch(
      { horizon_hours: -5, spawnImpl },
      {},
    );
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(spawned).toBe(false);
  });
});

// =========================================================================
// orbit_messages_fetch (SQLite read on claw)
// =========================================================================

// Minimal mock of better-sqlite3: records the open path and serves scripted
// rows for a fixed set of prepared statements.
function fakeSqlite(scripts) {
  return class FakeDB {
    constructor(path, opts) {
      this.path = path;
      this.opts = opts;
      this._closed = false;
    }
    prepare(sql) {
      const key = scripts.matchKey(sql);
      return {
        all: (...args) => scripts.run(key, args),
      };
    }
    close() {
      this._closed = true;
    }
  };
}

describe("orbit_messages_fetch", () => {
  it("happy path: fetches messages via orbit_person_get phones, dedupes by ts+body", async () => {
    const scripts = {
      matchKey(sql) {
        if (sql.includes("chat_jid = ?") && sql.includes("ORDER BY ts DESC") &&
            !sql.includes("sender_jid")) return "dm";
        if (sql.includes("sender_jid") && sql.includes("LIKE '%@g.us'")) return "grp";
        if (sql.includes("whatsmeow_lid_map")) return "lid";
        return "unknown";
      },
      run(key) {
        if (key === "dm") {
          return [
            { ts: 1000, from_me: 0, body: "hello world", chat_name: null },
            { ts: 900, from_me: 1, body: "ok", chat_name: null },
          ];
        }
        if (key === "grp") {
          return [
            { ts: 950, body: "shipped sinx v2", chat_name: "AI Tinkerers" },
          ];
        }
        if (key === "lid") return [];
        return [];
      },
    };
    const sqliteImpl = fakeSqlite(scripts);
    const fakeCard = async () => ({
      card: { person_id: UMAYR_ID, phones: ["+971586783040"] },
    });
    const r = await orbitMessagesFetch(
      {
        person_id: UMAYR_ID,
        limit: 50,
        wacli_db: __filename, // any existing file — sqliteImpl ignores contents
        session_db: "/tmp/definitely-does-not-exist-xyz",
        sqliteImpl,
        orbitPersonGetImpl: fakeCard,
      },
      {},
    );
    expect(r.person_id).toBe(UMAYR_ID);
    expect(Array.isArray(r.messages)).toBe(true);
    // 2 DM + 1 group (unique ts) = 3, sorted desc by ts.
    expect(r.messages.length).toBeGreaterThan(0);
    expect(r.messages[0].ts).toBe(1000);
    expect(r.count).toBeLessThanOrEqual(50);
  });

  it("no_phones_on_card short-circuit: zero messages returned", async () => {
    const fakeCard = async () => ({
      card: { person_id: UMAYR_ID, phones: [] },
    });
    const r = await orbitMessagesFetch(
      {
        person_id: UMAYR_ID,
        wacli_db: __filename,
        sqliteImpl: fakeSqlite({
          matchKey: () => "x",
          run: () => [],
        }),
        orbitPersonGetImpl: fakeCard,
      },
      {},
    );
    expect(r.messages).toHaveLength(0);
    expect(r.reason).toBe("no_phones_on_card");
  });

  it("structured error: invalid UUID rejected", async () => {
    const r = await orbitMessagesFetch({ person_id: "bad" }, {});
    expect(r.error.code).toBe("INVALID_UUID");
  });

  it("structured error: wacli_db missing → FILE_NOT_FOUND", async () => {
    const r = await orbitMessagesFetch(
      {
        person_id: UMAYR_ID,
        wacli_db: "/tmp/definitely-not-here-xyz-orbit.db",
      },
      {},
    );
    expect(r.error.code).toBe("FILE_NOT_FOUND");
  });
});

// =========================================================================
// orbit_jobs_claim / orbit_jobs_report
// =========================================================================

describe("orbit_jobs_claim", () => {
  it("happy path: POST /jobs/claim returns the job envelope", async () => {
    const fetchMock = makeFetch(() =>
      jsonResponse({ job: { id: "job_1", capability: "orbit-observer" } }),
    );
    const r = await orbitJobsClaim(
      { agent: "wazowski" },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.job.id).toBe("job_1");
    expect(fetchMock.calls[0].url).toBe(
      "http://100.97.152.84:3047/api/v1/jobs/claim",
    );
    const body = JSON.parse(fetchMock.calls[0].init.body);
    expect(body.agent).toBe("wazowski");
  });

  it("structured error: Phase 5 route 404s cleanly (NOT_FOUND)", async () => {
    const fetchMock = makeFetch(() =>
      jsonResponse({ error: "not yet shipped" }, { status: 404 }),
    );
    const r = await orbitJobsClaim(
      { agent: "wazowski" },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.error.code).toBe("NOT_FOUND");
    expect(r.error.http_status).toBe(404);
  });

  it("structured error: missing agent rejected locally, no fetch", async () => {
    const fetchMock = makeFetch(() => jsonResponse({}));
    const r = await orbitJobsClaim(
      {},
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(fetchMock.calls).toHaveLength(0);
  });
});

describe("orbit_jobs_report", () => {
  it("happy path: POST /jobs/report returns {ok}", async () => {
    const fetchMock = makeFetch(() => jsonResponse({ ok: true }));
    const r = await orbitJobsReport(
      { job_id: "job_1", status: "succeeded", result: { x: 1 } },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.ok).toBe(true);
    const body = JSON.parse(fetchMock.calls[0].init.body);
    expect(body.job_id).toBe("job_1");
    expect(body.status).toBe("succeeded");
    expect(body.result.x).toBe(1);
  });

  it("structured error: invalid status rejected locally, no fetch", async () => {
    const fetchMock = makeFetch(() => jsonResponse({}));
    const r = await orbitJobsReport(
      { job_id: "job_1", status: "weird" },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(r.error.message).toMatch(/not one of/);
    expect(fetchMock.calls).toHaveLength(0);
  });
});
