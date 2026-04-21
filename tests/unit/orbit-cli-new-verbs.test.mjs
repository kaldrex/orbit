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
  orbitLidBridgeUpsert,
  orbitRawEventsBackfillFromWacli,
  orbitLidBridgeIngest,
  orbitInteractionsBackfill,
  rawEventToInteractionObservation,
  wacliRowsToRawEvents,
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
      jsonResponse({ job: { id: "job_1", kind: "observer", payload: {} } }),
    );
    const r = await orbitJobsClaim(
      { agent: "wazowski", kinds: ["observer", "enricher"] },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.job.id).toBe("job_1");
    expect(fetchMock.calls[0].url).toBe(
      "http://100.97.152.84:3047/api/v1/jobs/claim",
    );
    const body = JSON.parse(fetchMock.calls[0].init.body);
    expect(body.agent).toBe("wazowski");
    expect(body.kinds).toEqual(["observer", "enricher"]);
  });

  it("empty queue: server returns {job:null}", async () => {
    const fetchMock = makeFetch(() => jsonResponse({ job: null }));
    const r = await orbitJobsClaim(
      { agent: "wazowski", kinds: ["observer"] },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.job).toBeNull();
  });

  it("structured error: missing agent rejected locally, no fetch", async () => {
    const fetchMock = makeFetch(() => jsonResponse({}));
    const r = await orbitJobsClaim(
      { kinds: ["observer"] },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("structured error: missing kinds rejected locally, no fetch", async () => {
    const fetchMock = makeFetch(() => jsonResponse({}));
    const r = await orbitJobsClaim(
      { agent: "wazowski" },
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

// =========================================================================
// orbit_lid_bridge_upsert
// =========================================================================

describe("orbit_lid_bridge_upsert", () => {
  function entry(lid = "135046807695474", phone = "919136820958") {
    return { lid, phone };
  }

  it("happy path: POST /lid_bridge/upsert returns {upserted}", async () => {
    const fetchMock = makeFetch(() => jsonResponse({ upserted: 2 }));
    const r = await orbitLidBridgeUpsert(
      {
        entries: [
          entry("135046807695474", "919136820958"),
          entry("19812700926200", "917506660554"),
        ],
      },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.upserted).toBe(2);
    expect(fetchMock.calls[0].url).toBe(
      "http://100.97.152.84:3047/api/v1/lid_bridge/upsert",
    );
    const body = JSON.parse(fetchMock.calls[0].init.body);
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0].lid).toBe("135046807695474");
    expect(body.entries[0].phone).toBe("919136820958");
  });

  it("structured error: empty batch rejected locally, no fetch", async () => {
    const fetchMock = makeFetch(() => jsonResponse({}));
    const r = await orbitLidBridgeUpsert(
      { entries: [] },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.error).toBeDefined();
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(r.error.message).toMatch(/empty/);
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("structured error: > 1000 entries rejected locally", async () => {
    const many = Array.from({ length: 1001 }, (_, i) =>
      entry(String(1000000 + i), String(910000000000 + i)),
    );
    const fetchMock = makeFetch(() => jsonResponse({}));
    const r = await orbitLidBridgeUpsert(
      { entries: many },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(r.error.message).toMatch(/exceeds server cap/);
    expect(fetchMock.calls).toHaveLength(0);
  });
});

// =========================================================================
// Phase B — onboarding backfill verbs
// =========================================================================

// Minimal better-sqlite3 stand-in for the backfill verbs. Records what
// SQL was run and serves scripted rows.
function fakeWacliSqlite({ messages = [], lidMap = [] } = {}) {
  return class FakeDB {
    constructor(path, opts) {
      this.path = path;
      this.opts = opts;
      this._closed = false;
    }
    prepare(sql) {
      return {
        all: () => {
          if (sql.includes("FROM messages m")) return messages;
          if (sql.includes("whatsmeow_lid_map")) return lidMap;
          return [];
        },
      };
    }
    close() {
      this._closed = true;
    }
  };
}

// =========================================================================
// wacliRowsToRawEvents (pure mapping)
// =========================================================================

describe("wacliRowsToRawEvents", () => {
  it("projects a DM row into a shaped raw_events envelope", () => {
    const rows = [
      {
        chat_jid: "971586783040@s.whatsapp.net",
        msg_id: "M1",
        sender_jid: "971586783040@s.whatsapp.net",
        sender_name: "Umayr",
        ts: 1_700_000_000,
        from_me: 0,
        text: "hi",
        display_text: null,
        media_caption: null,
        media_type: null,
        kind: "dm",
        chat_name: "Umayr",
      },
    ];
    const out = wacliRowsToRawEvents(rows);
    expect(out).toHaveLength(1);
    const e = out[0];
    expect(e.source).toBe("whatsapp");
    expect(e.source_event_id).toBe("971586783040@s.whatsapp.net|M1");
    expect(e.direction).toBe("in");
    expect(e.participant_phones).toEqual(["+971586783040"]);
    expect(e.body_preview).toBe("hi");
    expect(e.raw_ref.msg_id).toBe("M1");
  });

  it("strips NULs from body_preview and raw_ref", () => {
    const rows = [
      {
        chat_jid: "1@s.whatsapp.net",
        msg_id: "m",
        sender_jid: "1@s.whatsapp.net",
        sender_name: "Nam\u0000e",
        ts: 1,
        from_me: 0,
        text: "hi\u0000there",
        display_text: null,
        media_caption: null,
        media_type: null,
        kind: "dm",
        chat_name: "Co\u0000ol",
      },
    ];
    const out = wacliRowsToRawEvents(rows);
    expect(out[0].body_preview).not.toContain("\u0000");
    expect(out[0].raw_ref.chat_name).not.toContain("\u0000");
    expect(out[0].participants_raw[0].name).not.toContain("\u0000");
  });
});

// =========================================================================
// orbit_raw_events_backfill_from_wacli
// =========================================================================

describe("orbit_raw_events_backfill_from_wacli", () => {
  it("happy path: reads wacli → POSTs batches of 500 → returns counts", async () => {
    // 1,100 rows → 3 batches of [500, 500, 100].
    const messages = Array.from({ length: 1100 }, (_, i) => ({
      chat_jid: `c${i}@s.whatsapp.net`,
      msg_id: `m${i}`,
      sender_jid: `${9000000000 + i}@s.whatsapp.net`,
      sender_name: "Peer",
      ts: 1_700_000_000 + i,
      from_me: i % 2,
      text: `msg ${i}`,
      display_text: null,
      media_caption: null,
      media_type: null,
      kind: "dm",
      chat_name: null,
    }));
    const sqliteImpl = fakeWacliSqlite({ messages });
    const fetchMock = makeFetch(() =>
      jsonResponse({ ok: true, accepted: 500, inserted: 500, updated: 0 }),
    );
    const r = await orbitRawEventsBackfillFromWacli(
      {
        wacli_db: __filename, // any existing file; fake sqlite ignores contents
        sqliteImpl,
      },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.ok).toBe(true);
    expect(r.total_rows).toBe(1100);
    expect(r.batches_posted).toBe(3);
    // inserted = sum of fake responses (3 × 500 = 1500) — test only
    // checks the plumbing, not the server math.
    expect(r.total_inserted).toBe(1500);
    expect(r.failed_batches).toHaveLength(0);
    expect(fetchMock.calls).toHaveLength(3);
    expect(fetchMock.calls[0].url).toBe(
      "http://100.97.152.84:3047/api/v1/raw_events",
    );
  });

  it("dry_run: no POSTs, just count", async () => {
    const messages = Array.from({ length: 17 }, (_, i) => ({
      chat_jid: `c${i}@s.whatsapp.net`,
      msg_id: `m${i}`,
      sender_jid: `100${i}@s.whatsapp.net`,
      sender_name: "P",
      ts: 1_700_000_000 + i,
      from_me: 0,
      text: "x",
      display_text: null,
      media_caption: null,
      media_type: null,
      kind: "dm",
      chat_name: null,
    }));
    const sqliteImpl = fakeWacliSqlite({ messages });
    const fetchMock = makeFetch(() => jsonResponse({}));
    const r = await orbitRawEventsBackfillFromWacli(
      { wacli_db: __filename, dry_run: true, sqliteImpl },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.ok).toBe(true);
    expect(r.dry_run).toBe(true);
    expect(r.count).toBe(17);
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("structured error: missing wacli_db → FILE_NOT_FOUND", async () => {
    const fetchMock = makeFetch(() => jsonResponse({}));
    const r = await orbitRawEventsBackfillFromWacli(
      { wacli_db: "/tmp/orbit-not-here-xyz.db" },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.error.code).toBe("FILE_NOT_FOUND");
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("structured error: invalid batch_size rejected locally", async () => {
    const sqliteImpl = fakeWacliSqlite({ messages: [] });
    const fetchMock = makeFetch(() => jsonResponse({}));
    const r = await orbitRawEventsBackfillFromWacli(
      { wacli_db: __filename, batch_size: 5000, sqliteImpl },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(r.error.message).toMatch(/out of range/);
    expect(fetchMock.calls).toHaveLength(0);
  });
});

// =========================================================================
// orbit_lid_bridge_ingest
// =========================================================================

describe("orbit_lid_bridge_ingest", () => {
  it("happy path: reads session.db → chunks → POSTs bridge entries", async () => {
    const lidMap = Array.from({ length: 1200 }, (_, i) => ({
      lid: String(100000 + i),
      pn: String(919000000000 + i),
    }));
    const sqliteImpl = fakeWacliSqlite({ lidMap });
    const fetchMock = makeFetch(() => jsonResponse({ upserted: 500 }));
    const r = await orbitLidBridgeIngest(
      { session_db: __filename, sqliteImpl },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.ok).toBe(true);
    expect(r.rows_dumped).toBe(1200);
    expect(r.batches_posted).toBe(3); // 500 + 500 + 200
    expect(r.total_upserted).toBe(1500);
    expect(fetchMock.calls).toHaveLength(3);
    expect(fetchMock.calls[0].url).toBe(
      "http://100.97.152.84:3047/api/v1/lid_bridge/upsert",
    );
    const body = JSON.parse(fetchMock.calls[0].init.body);
    expect(body.entries).toHaveLength(500);
    expect(body.entries[0].lid).toBe("100000");
    expect(body.entries[0].phone).toBe("919000000000");
  });

  it("drops rows with missing lid or pn", async () => {
    const lidMap = [
      { lid: "123", pn: "9199" },
      { lid: "", pn: "9199" }, // skip
      { lid: "456", pn: "" }, // skip
      { lid: null, pn: null }, // skip
    ];
    const sqliteImpl = fakeWacliSqlite({ lidMap });
    const fetchMock = makeFetch(() => jsonResponse({ upserted: 1 }));
    const r = await orbitLidBridgeIngest(
      { session_db: __filename, sqliteImpl },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.rows_dumped).toBe(1);
    expect(fetchMock.calls).toHaveLength(1);
    const body = JSON.parse(fetchMock.calls[0].init.body);
    expect(body.entries).toHaveLength(1);
  });

  it("no rows → {rows_dumped:0, batches_posted:0} and no POST", async () => {
    const sqliteImpl = fakeWacliSqlite({ lidMap: [] });
    const fetchMock = makeFetch(() => jsonResponse({}));
    const r = await orbitLidBridgeIngest(
      { session_db: __filename, sqliteImpl },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.ok).toBe(true);
    expect(r.rows_dumped).toBe(0);
    expect(r.batches_posted).toBe(0);
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("structured error: missing session_db → FILE_NOT_FOUND", async () => {
    const r = await orbitLidBridgeIngest(
      { session_db: "/tmp/orbit-def-not-here-xyz.db" },
      { config: CFG },
    );
    expect(r.error.code).toBe("FILE_NOT_FOUND");
  });
});

// =========================================================================
// rawEventToInteractionObservation (pure)
// =========================================================================

describe("rawEventToInteractionObservation", () => {
  function dmRow(overrides = {}) {
    return {
      source_event_id: "971586783040@s.whatsapp.net|M1",
      occurred_at: "2026-04-19T10:00:00.000Z",
      direction: "in",
      thread_id: "971586783040@s.whatsapp.net",
      participants_raw: [{ jid: "971586783040@s.whatsapp.net", name: "Umayr" }],
      participant_phones: ["+971586783040"],
      body_preview: "hi there",
      raw_ref: { kind: "dm" },
      ...overrides,
    };
  }

  it("projects a DM row into a valid kind:'interaction' observation", () => {
    const obs = rawEventToInteractionObservation(dmRow(), { self_name: "Sanchay" });
    expect(obs.kind).toBe("interaction");
    expect(obs.observer).toBe("wazowski");
    expect(obs.payload.participants).toEqual(["Sanchay", "Umayr"]);
    expect(obs.payload.channel).toBe("whatsapp");
    expect(obs.payload.summary).toMatch(/Inbound WhatsApp/);
    expect(obs.evidence_pointer).toBe(
      "wacli://messages/source_event_id=971586783040@s.whatsapp.net|M1",
    );
  });

  it("skips group-kind rows (returns null)", () => {
    const r = rawEventToInteractionObservation(
      dmRow({ raw_ref: { kind: "group" } }),
      { self_name: "Sanchay" },
    );
    expect(r).toBeNull();
  });

  it("skips rows without a participant phone", () => {
    const r = rawEventToInteractionObservation(
      dmRow({ participant_phones: [] }),
      { self_name: "Sanchay" },
    );
    expect(r).toBeNull();
  });

  it("falls back to phone when peer name is 'me' or missing", () => {
    const obs = rawEventToInteractionObservation(
      dmRow({ participants_raw: [{ name: "me" }] }),
      { self_name: "Sanchay" },
    );
    expect(obs.payload.participants[1]).toBe("+971586783040");
  });

  it("maps direction:'out' to 'Outbound' in summary", () => {
    const obs = rawEventToInteractionObservation(
      dmRow({ direction: "out" }),
      { self_name: "S" },
    );
    expect(obs.payload.summary).toMatch(/Outbound/);
  });
});

// =========================================================================
// orbit_interactions_backfill
// =========================================================================

describe("orbit_interactions_backfill", () => {
  function evt(i) {
    return {
      id: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa${String(i).padStart(3, "0")}`,
      source_event_id: `${9000000000 + i}@s.whatsapp.net|m${i}`,
      occurred_at: `2026-04-${10 + (i % 10)}T10:00:00.000Z`,
      direction: i % 2 ? "out" : "in",
      thread_id: `${9000000000 + i}@s.whatsapp.net`,
      participants_raw: [{ name: `Peer${i}` }],
      participant_phones: [`+${9000000000 + i}`],
      body_preview: `msg ${i}`,
      raw_ref: { kind: "dm" },
    };
  }

  it("happy path: paginates raw_events → POSTs observations in chunks", async () => {
    // 250 events across 3 pages (100, 100, 50), chunked into observations of 100 each
    // so 3 /observations POSTs.
    const pages = [
      { events: Array.from({ length: 100 }, (_, i) => evt(i)), next_cursor: "c1" },
      { events: Array.from({ length: 100 }, (_, i) => evt(i + 100)), next_cursor: "c2" },
      { events: Array.from({ length: 50 }, (_, i) => evt(i + 200)), next_cursor: null },
    ];
    let pageIdx = 0;
    const fetchMock = makeFetch((url) => {
      if (url.includes("/raw_events")) {
        return jsonResponse(pages[pageIdx++] ?? { events: [], next_cursor: null });
      }
      if (url.includes("/observations")) {
        return jsonResponse({ ok: true, accepted: 100, inserted: 100, deduped: 0 });
      }
      return jsonResponse({}, { status: 500 });
    });
    const r = await orbitInteractionsBackfill(
      { limit: 100, batch_size: 100, self_name: "Sanchay" },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.ok).toBe(true);
    expect(r.pages_scanned).toBe(3);
    expect(r.rows_scanned).toBe(250);
    expect(r.observations_posted).toBe(250);
    expect(r.failed_batches).toHaveLength(0);

    // /raw_events hits: 3 (one per page)
    const rawHits = fetchMock.calls.filter((c) => c.url.includes("/raw_events"));
    expect(rawHits).toHaveLength(3);
    // /observations hits: 3 (250 / 100 → batches of 100, 100, 50)
    const obsHits = fetchMock.calls.filter((c) => c.url.includes("/observations"));
    expect(obsHits).toHaveLength(3);
  });

  it("skips group-kind rows when projecting", async () => {
    const events = [
      evt(1),
      { ...evt(2), raw_ref: { kind: "group" } },
      evt(3),
      { ...evt(4), participant_phones: [] },
    ];
    const fetchMock = makeFetch((url) => {
      if (url.includes("/raw_events")) {
        return jsonResponse({ events, next_cursor: null });
      }
      return jsonResponse({ ok: true, accepted: 2, inserted: 2, deduped: 0 });
    });
    const r = await orbitInteractionsBackfill(
      { limit: 100, batch_size: 100 },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.rows_scanned).toBe(4);
    expect(r.observations_posted).toBe(2); // group + phoneless dropped
  });

  it("dry_run: no /observations POSTs, count only", async () => {
    const events = Array.from({ length: 12 }, (_, i) => evt(i));
    let hit = 0;
    const fetchMock = makeFetch((url) => {
      hit += 1;
      if (url.includes("/raw_events")) {
        return jsonResponse({ events, next_cursor: null });
      }
      return jsonResponse({}, { status: 500 });
    });
    const r = await orbitInteractionsBackfill(
      { limit: 50, batch_size: 50, dry_run: true },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.dry_run).toBe(true);
    expect(r.observations_posted).toBe(12);
    // Only /raw_events hit, never /observations.
    const obsHits = fetchMock.calls.filter((c) => c.url.includes("/observations"));
    expect(obsHits).toHaveLength(0);
  });

  it("structured error: unsupported source rejected locally", async () => {
    const fetchMock = makeFetch(() => jsonResponse({}));
    const r = await orbitInteractionsBackfill(
      { source: "gmail" },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("records failed /observations batches without aborting", async () => {
    const events = Array.from({ length: 10 }, (_, i) => evt(i));
    const fetchMock = makeFetch((url) => {
      if (url.includes("/raw_events")) {
        return jsonResponse({ events, next_cursor: null });
      }
      return jsonResponse({ error: "boom" }, { status: 500 });
    });
    const r = await orbitInteractionsBackfill(
      { limit: 100, batch_size: 100 },
      { config: CFG, fetchImpl: fetchMock },
    );
    expect(r.ok).toBe(true);
    expect(r.failed_batches).toHaveLength(1);
    expect(r.failed_batches[0].http_status).toBe(500);
  });
});
