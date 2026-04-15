import neo4j, { Driver } from "neo4j-driver";

let driver: Driver | null = null;

function getDriver(): Driver {
  if (!driver) {
    const uri = (process.env.NEO4J_URI || "").trim();
    const user = (process.env.NEO4J_USER || "").trim();
    const password = (process.env.NEO4J_PASSWORD || "").trim();

    // Diagnostic: log env var lengths to catch trailing newlines
    console.log(`[neo4j] creating driver: uri=${uri.length}chars, user=${user.length}chars, pass=${password.length}chars`);

    driver = neo4j.driver(
      uri,
      neo4j.auth.basic(user, password),
      { maxConnectionPoolSize: 50 }
    );
  }
  return driver;
}

/**
 * Recursively unwrap Neo4j driver types to plain JS values.
 * Handles: Integer → number, Node → properties object, Relationship → properties.
 */
function unwrapValue(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (neo4j.isInt(val)) return (val as { toNumber(): number }).toNumber();
  // Node object — has .properties
  if (typeof val === "object" && val !== null && "properties" in val && "labels" in val) {
    const props = (val as { properties: Record<string, unknown> }).properties;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      out[k] = unwrapValue(v);
    }
    return out;
  }
  // Relationship object
  if (typeof val === "object" && val !== null && "properties" in val && "type" in val) {
    const props = (val as { properties: Record<string, unknown> }).properties;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      out[k] = unwrapValue(v);
    }
    return out;
  }
  if (Array.isArray(val)) return val.map(unwrapValue);
  return val;
}

/**
 * Tenant-isolated Neo4j query helper.
 * Every query receives a `userId` param for multi-tenant isolation.
 * Callers MUST include `WHERE ... userId = $userId` in their Cypher.
 */
export async function queryNeo4j<T = Record<string, unknown>>(
  userId: string,
  cypher: string,
  params: Record<string, unknown> = {}
): Promise<T[]> {
  const session = getDriver().session({
    database: (process.env.NEO4J_DATABASE || "neo4j").trim(),
  });
  try {
    const result = await session.run(cypher, { ...params, userId });
    return result.records.map((r) => {
      const obj: Record<string, unknown> = {};
      for (const key of r.keys) {
        obj[key as string] = unwrapValue(r.get(key));
      }
      return obj as T;
    });
  } finally {
    await session.close();
  }
}

/**
 * Write query helper — same as queryNeo4j but uses WRITE access mode.
 */
export async function writeNeo4j(
  userId: string,
  cypher: string,
  params: Record<string, unknown> = {}
): Promise<void> {
  const session = getDriver().session({
    database: (process.env.NEO4J_DATABASE || "neo4j").trim(),
    defaultAccessMode: neo4j.session.WRITE,
  });
  try {
    await session.run(cypher, { ...params, userId });
  } finally {
    await session.close();
  }
}
