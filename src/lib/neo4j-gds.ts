// Neo4j GDS helpers for the graph-intelligence routes.
//
// Each route projects the user's subgraph into a named in-memory GDS
// graph, runs the algorithm, then drops the projection. The projection
// name is per-user + per-algo so concurrent requests don't stomp.
//
// All weights are AFFINITY (higher = closer). Dijkstra wants COST
// (lower = shorter), so the projection adds a derived `cost = 1/weight`
// relationship property. See the route file for the rationale.

import type { Session } from "neo4j-driver";

/**
 * Build a deterministic graph name. Scoped to `userId` + `algo` so
 * concurrent callers for different users don't collide, and the same
 * user running the same algo twice reuses the name (caller must drop
 * before reproject to avoid "already exists" errors).
 */
export function graphName(userId: string, algo: string): string {
  // gds graph names must be alphanumeric + underscore; UUID dashes are
  // fine in practice but we strip them for safety.
  const safeUser = userId.replace(/[^a-zA-Z0-9]/g, "");
  const safeAlgo = algo.replace(/[^a-zA-Z0-9]/g, "");
  return `orbit_${safeAlgo}_${safeUser}`;
}

/**
 * Drop the named graph if it exists. Safe to call even if the graph was
 * never projected (the `false` flag means "don't fail if missing").
 */
export async function dropIfExists(session: Session, name: string): Promise<void> {
  await session.run(
    "CALL gds.graph.drop($name, false) YIELD graphName RETURN graphName",
    { name },
  );
}

/**
 * Project the user's Person subgraph with DM / SHARED_GROUP / EMAILED
 * edges, undirected, carrying `weight` (affinity) and a derived `cost`
 * (1 / weight) for Dijkstra.
 *
 * Uses GDS 2.x Cypher-projection syntax (`gds.graph.project` aggregation
 * function). Falls back to a clean error if the procedure isn't callable
 * (e.g. Aura tier without Graph Analytics).
 *
 * Returns the graph's (nodeCount, relationshipCount) as reported by GDS.
 */
export async function projectUserGraph(
  session: Session,
  name: string,
  userId: string,
): Promise<{ nodes: number; edges: number }> {
  // Make sure a stale graph of the same name doesn't linger from a
  // previous failed request.
  await dropIfExists(session, name);

  const result = await session.run(
    `
    MATCH (source:Person {user_id: $userId})
    OPTIONAL MATCH (source)-[r:DM|SHARED_GROUP|EMAILED]-(target:Person {user_id: $userId})
    WITH source, target, r,
         CASE
           WHEN r IS NULL THEN null
           WHEN coalesce(r.weight, 0) <= 0 THEN 1000000.0
           ELSE 1.0 / r.weight
         END AS cost
    WITH gds.graph.project(
      $name,
      source,
      target,
      {
        sourceNodeProperties: source { .id },
        targetNodeProperties: CASE WHEN target IS NULL THEN null ELSE target { .id } END,
        relationshipProperties: r { .weight, cost: cost },
        relationshipType: coalesce(type(r), 'NONE')
      },
      { undirectedRelationshipTypes: ['*'] }
    ) AS g
    RETURN g.graphName AS graphName, g.nodeCount AS nodes, g.relationshipCount AS edges
    `,
    { userId, name },
  );

  const rec = result.records[0];
  if (!rec) return { nodes: 0, edges: 0 };
  return {
    nodes: numberOf(rec.get("nodes")),
    edges: numberOf(rec.get("edges")),
  };
}

function numberOf(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "object" && v !== null && "toNumber" in (v as object)) {
    try {
      return (v as { toNumber: () => number }).toNumber();
    } catch {
      return 0;
    }
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Classify a GDS-related error for HTTP mapping.
 *
 * - "gds_missing": procedure not registered, or (on Aura) Graph
 *   Analytics not authenticated. HTTP 501.
 * - "unreachable": connection-level Neo4j failure. HTTP 503.
 * - "other": unknown, rethrow / 500.
 */
export function classifyGdsError(err: unknown): "gds_missing" | "unreachable" | "other" {
  if (!err || typeof err !== "object") return "other";
  const e = err as { code?: unknown; message?: unknown; name?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  const name = typeof e.name === "string" ? e.name : "";
  const message = typeof e.message === "string" ? e.message : "";

  // Transient / connectivity → service unavailable.
  if (
    code === "ServiceUnavailable" ||
    code === "SessionExpired" ||
    name === "ServiceUnavailable" ||
    code.startsWith("Neo.TransientError.")
  ) {
    return "unreachable";
  }

  // GDS procedure not installed or not authenticated (Aura) → 501.
  if (
    /no procedure with the name `gds\./i.test(message) ||
    /no procedure with the name `?gds/i.test(message) ||
    /Aura API credentials/i.test(message) ||
    /Graph Data Science/i.test(message)
  ) {
    return "gds_missing";
  }

  // `gds.version()` throws UnsupportedOperationException on Aura
  // (versionless). Any other gds.* procedure referencing this signals
  // a Graph-Analytics-not-enabled state.
  if (/Aura Graph Analytics/i.test(message)) return "gds_missing";

  return "other";
}
