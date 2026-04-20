import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeSession = {
  close: ReturnType<typeof vi.fn>;
  id: number;
};

type FakeDriver = {
  session: ReturnType<typeof vi.fn>;
  verifyConnectivity: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  sessions: FakeSession[];
};

let fakeDriver: FakeDriver;
let driverFactoryCalls: number;

vi.mock("neo4j-driver", () => {
  const driverFn = vi.fn(() => {
    driverFactoryCalls += 1;
    return fakeDriver;
  });
  return {
    default: {
      driver: driverFn,
      auth: { basic: (u: string, p: string) => ({ scheme: "basic", u, p }) },
      session: { READ: "READ", WRITE: "WRITE" },
    },
    driver: driverFn,
    auth: { basic: (u: string, p: string) => ({ scheme: "basic", u, p }) },
    session: { READ: "READ", WRITE: "WRITE" },
  };
});

function newFakeDriver(): FakeDriver {
  const sessions: FakeSession[] = [];
  return {
    sessions,
    session: vi.fn(() => {
      const s: FakeSession = { close: vi.fn().mockResolvedValue(undefined), id: sessions.length };
      sessions.push(s);
      return s;
    }),
    verifyConnectivity: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

async function freshModule() {
  vi.resetModules();
  return await import("../../src/lib/neo4j");
}

beforeEach(() => {
  process.env.NEO4J_URI = "neo4j+s://example.databases.neo4j.io";
  process.env.NEO4J_USER = "testuser";
  process.env.NEO4J_PASSWORD = "testpass";
  process.env.NEO4J_DATABASE = "testdb";
  fakeDriver = newFakeDriver();
  driverFactoryCalls = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("getDriver", () => {
  it("returns the same driver instance on repeat calls (singleton)", async () => {
    const m = await freshModule();
    const a = m.getDriver();
    const b = m.getDriver();
    expect(a).toBe(b);
    expect(driverFactoryCalls).toBe(1);
  });

  it("throws a descriptive error when NEO4J_URI is missing", async () => {
    delete process.env.NEO4J_URI;
    const m = await freshModule();
    expect(() => m.getDriver()).toThrow(/NEO4J_URI/);
  });

  it("throws when NEO4J_DATABASE is missing (required for session routing)", async () => {
    delete process.env.NEO4J_DATABASE;
    const m = await freshModule();
    expect(() => m.getDriver()).toThrow(/NEO4J_DATABASE/);
  });

  it("trims whitespace/newlines on env vars (Aura export quirk)", async () => {
    process.env.NEO4J_URI = "neo4j+s://example.databases.neo4j.io\n";
    process.env.NEO4J_USER = "testuser\n";
    const m = await freshModule();
    expect(() => m.getDriver()).not.toThrow();
  });
});

describe("withSession", () => {
  it("closes the session after fn resolves", async () => {
    const m = await freshModule();
    const result = await m.withSession(async () => 42);
    expect(result).toBe(42);
    expect(fakeDriver.sessions).toHaveLength(1);
    expect(fakeDriver.sessions[0].close).toHaveBeenCalledTimes(1);
  });

  it("closes the session after fn throws (finally)", async () => {
    const m = await freshModule();
    await expect(
      m.withSession(async () => {
        const err = new Error("boom") as Error & { code: string };
        err.code = "Neo.ClientError.Statement.SyntaxError";
        throw err;
      }),
    ).rejects.toThrow(/boom/);
    expect(fakeDriver.sessions).toHaveLength(1);
    expect(fakeDriver.sessions[0].close).toHaveBeenCalledTimes(1);
  });

  it("passes database and access mode to driver.session()", async () => {
    const m = await freshModule();
    await m.withSession(async () => null, { database: "other", mode: "WRITE" });
    expect(fakeDriver.session).toHaveBeenCalledWith({
      database: "other",
      defaultAccessMode: "WRITE",
    });
  });

  it("defaults to READ mode and NEO4J_DATABASE env", async () => {
    const m = await freshModule();
    await m.withSession(async () => null);
    expect(fakeDriver.session).toHaveBeenCalledWith({
      database: "testdb",
      defaultAccessMode: "READ",
    });
  });
});

describe("retry behaviour", () => {
  it("retries on transient errors and eventually succeeds", async () => {
    const m = await freshModule();
    let calls = 0;
    const result = await m.withSession(async () => {
      calls += 1;
      if (calls < 3) {
        const err = new Error("lost connection") as Error & { code: string };
        err.code = "ServiceUnavailable";
        throw err;
      }
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(fakeDriver.sessions).toHaveLength(3);
    for (const s of fakeDriver.sessions) {
      expect(s.close).toHaveBeenCalledTimes(1);
    }
  });

  it("does NOT retry on permanent (Neo.ClientError.*) errors", async () => {
    const m = await freshModule();
    let calls = 0;
    await expect(
      m.withSession(async () => {
        calls += 1;
        const err = new Error("syntax") as Error & { code: string };
        err.code = "Neo.ClientError.Statement.SyntaxError";
        throw err;
      }),
    ).rejects.toThrow(/syntax/);
    expect(calls).toBe(1);
    expect(fakeDriver.sessions).toHaveLength(1);
  });

  it("gives up after 2 retries (3 total attempts) on persistent transient errors", async () => {
    const m = await freshModule();
    let calls = 0;
    await expect(
      m.withSession(async () => {
        calls += 1;
        const err = new Error("still down") as Error & { code: string };
        err.code = "SessionExpired";
        throw err;
      }),
    ).rejects.toThrow(/still down/);
    expect(calls).toBe(3);
  });
});

describe("convenience wrappers", () => {
  it("withReadSession forces READ mode", async () => {
    const m = await freshModule();
    await m.withReadSession(async () => null);
    expect(fakeDriver.session).toHaveBeenCalledWith({
      database: "testdb",
      defaultAccessMode: "READ",
    });
  });

  it("withWriteSession forces WRITE mode", async () => {
    const m = await freshModule();
    await m.withWriteSession(async () => null);
    expect(fakeDriver.session).toHaveBeenCalledWith({
      database: "testdb",
      defaultAccessMode: "WRITE",
    });
  });
});

describe("verifyConnectivity", () => {
  it("calls driver.verifyConnectivity with the configured database", async () => {
    const m = await freshModule();
    await m.verifyConnectivity();
    expect(fakeDriver.verifyConnectivity).toHaveBeenCalledWith({ database: "testdb" });
  });
});

describe("closeDriver", () => {
  it("closes the driver and resets the singleton (new instance on next getDriver)", async () => {
    const m = await freshModule();
    const first = m.getDriver();
    expect(driverFactoryCalls).toBe(1);
    await m.closeDriver();
    expect(fakeDriver.close).toHaveBeenCalledTimes(1);

    fakeDriver = newFakeDriver();
    const second = m.getDriver();
    expect(driverFactoryCalls).toBe(2);
    expect(second).not.toBe(first);
  });

  it("is a no-op when no driver was ever created", async () => {
    const m = await freshModule();
    await expect(m.closeDriver()).resolves.toBeUndefined();
    expect(fakeDriver.close).not.toHaveBeenCalled();
  });
});
