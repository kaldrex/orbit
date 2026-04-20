import neo4j, {
  type Driver,
  type Session,
  type SessionMode,
} from "neo4j-driver";

type Mode = "READ" | "WRITE";

export interface WithSessionOpts {
  database?: string;
  mode?: Mode;
}

const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  "ServiceUnavailable",
  "SessionExpired",
  "Neo.TransientError",
]);

const RETRY_DELAYS_MS = [250, 1000];

let driverSingleton: Driver | null = null;

function readEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function requireEnv(name: string): string {
  const value = readEnv(name);
  if (!value) {
    throw new Error(
      `[neo4j] missing required env var ${name}. Set NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, NEO4J_DATABASE in .env.local.`,
    );
  }
  return value;
}

// Neo4j drivers are heavyweight connection pools per the official driver manual
// (README: "It should be enough to have a single driver per database per application").
// One driver per process; sessions are the lightweight disposable unit.
export function getDriver(): Driver {
  if (driverSingleton) return driverSingleton;
  const uri = requireEnv("NEO4J_URI");
  const user = requireEnv("NEO4J_USER");
  const password = requireEnv("NEO4J_PASSWORD");
  requireEnv("NEO4J_DATABASE");
  driverSingleton = neo4j.driver(uri, neo4j.auth.basic(user, password));
  return driverSingleton;
}

function classifyError(err: unknown): "transient" | "permanent" {
  if (!err || typeof err !== "object") return "permanent";
  const e = err as { code?: unknown; name?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  const name = typeof e.name === "string" ? e.name : "";
  if (code.startsWith("Neo.ClientError.")) return "permanent";
  if (TRANSIENT_CODES.has(code)) return "transient";
  if (TRANSIENT_CODES.has(name)) return "transient";
  if (code.startsWith("Neo.TransientError.")) return "transient";
  return "permanent";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toMode(mode: Mode | undefined): SessionMode {
  return mode === "WRITE" ? neo4j.session.WRITE : neo4j.session.READ;
}

export async function withSession<T>(
  fn: (session: Session) => Promise<T>,
  opts: WithSessionOpts = {},
): Promise<T> {
  const driver = getDriver();
  const database = opts.database?.trim() || requireEnv("NEO4J_DATABASE");
  const defaultAccessMode = toMode(opts.mode);

  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    const session = driver.session({ database, defaultAccessMode });
    try {
      return await fn(session);
    } catch (err) {
      lastErr = err;
      if (classifyError(err) === "permanent") throw err;
      if (attempt === RETRY_DELAYS_MS.length) throw err;
      await sleep(RETRY_DELAYS_MS[attempt]);
    } finally {
      await session.close();
    }
  }
  throw lastErr;
}

export function withReadSession<T>(
  fn: (session: Session) => Promise<T>,
  opts: Omit<WithSessionOpts, "mode"> = {},
): Promise<T> {
  return withSession(fn, { ...opts, mode: "READ" });
}

export function withWriteSession<T>(
  fn: (session: Session) => Promise<T>,
  opts: Omit<WithSessionOpts, "mode"> = {},
): Promise<T> {
  return withSession(fn, { ...opts, mode: "WRITE" });
}

export async function verifyConnectivity(): Promise<void> {
  const driver = getDriver();
  const database = requireEnv("NEO4J_DATABASE");
  await driver.verifyConnectivity({ database });
}

export async function closeDriver(): Promise<void> {
  const current = driverSingleton;
  driverSingleton = null;
  if (current) await current.close();
}
