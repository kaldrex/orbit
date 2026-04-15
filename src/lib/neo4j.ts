import neo4j, { Driver } from "neo4j-driver";

let driver: Driver | null = null;

function getDriver(): Driver {
  if (!driver) {
    driver = neo4j.driver(
      process.env.NEO4J_URI!,
      neo4j.auth.basic(process.env.NEO4J_USER!, process.env.NEO4J_PASSWORD!),
      { maxConnectionPoolSize: 50 }
    );
  }
  return driver;
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
    database: process.env.NEO4J_DATABASE || "neo4j",
  });
  try {
    const result = await session.run(cypher, { ...params, userId });
    return result.records.map((r) => {
      const obj: Record<string, unknown> = {};
      for (const key of r.keys) {
        const val = r.get(key);
        // Convert Neo4j Integer to JS number
        if (neo4j.isInt(val)) {
          obj[key as string] = val.toNumber();
        } else {
          obj[key as string] = val;
        }
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
    database: process.env.NEO4J_DATABASE || "neo4j",
    defaultAccessMode: neo4j.session.WRITE,
  });
  try {
    await session.run(cypher, { ...params, userId });
  } finally {
    await session.close();
  }
}
