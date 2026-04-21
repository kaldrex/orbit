import { NextResponse } from "next/server";
import { getAgentOrSessionAuth } from "@/lib/api-auth";
import { withReadSession } from "@/lib/neo4j";
import {
  classifyGdsError,
  dropIfExists,
  graphName,
  projectUserGraph,
} from "@/lib/neo4j-gds";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_NODES = 100;

interface CentralityNode {
  id: string;
  name: string | null;
  category: string | null;
  betweenness: number;
  degree: number;
}

/**
 * GET /api/v1/graph/centrality
 *
 * Betweenness centrality over the user's DM / SHARED_GROUP / EMAILED
 * subgraph. High-betweenness nodes are "bridges" — candidates for
 * "introduce X to Y" workflows. Unweighted (the standard definition;
 * weighted betweenness is a different algorithm on GDS).
 *
 * Response: { nodes: [{id, name, category, betweenness, degree}, ...] }
 *   - Sorted by betweenness desc, then by degree desc as tiebreaker.
 *   - Capped at MAX_NODES (100).
 *   - Degree is measured in the live graph (DM + SHARED_GROUP + EMAILED
 *     count), not pulled from GDS, so callers get an interpretable
 *     "how many people this person directly connects to" integer.
 *
 * Empty graph → 200 with { nodes: [] }.
 * Errors: 501 GDS_MISSING / 503 NEO4J_UNREACHABLE.
 */
export async function GET(request: Request) {
  const auth = await getAgentOrSessionAuth(request);
  if (!auth) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 },
    );
  }

  const name = graphName(auth.userId, "betweenness");

  try {
    const nodes = await withReadSession(async (session) => {
      const { edges } = await projectUserGraph(session, name, auth.userId);

      if (edges === 0) {
        await dropIfExists(session, name).catch(() => {});
        return [];
      }

      try {
        const res = await session.run(
          `CALL gds.betweenness.stream($graphName)
           YIELD nodeId, score
           WITH nodeId, score
           ORDER BY score DESC
           LIMIT $limit
           MATCH (p:Person) WHERE id(p) = nodeId AND p.user_id = $uid
           OPTIONAL MATCH (p)-[r:DM|SHARED_GROUP|EMAILED]-(:Person {user_id: $uid})
           WITH p, score, count(DISTINCT r) AS degree
           RETURN p.id AS id,
                  p.name AS name,
                  p.category AS category,
                  score AS betweenness,
                  degree AS degree
           ORDER BY score DESC, degree DESC`,
          { graphName: name, uid: auth.userId, limit: MAX_NODES },
        );

        const out: CentralityNode[] = res.records.map((r) => ({
          id: String(r.get("id")),
          name: strOrNull(r.get("name")),
          category: strOrNull(r.get("category")),
          betweenness: numOf(r.get("betweenness")),
          degree: numOf(r.get("degree")),
        }));
        return out;
      } finally {
        await dropIfExists(session, name).catch(() => {});
      }
    });

    return NextResponse.json({ nodes });
  } catch (err) {
    const cls = classifyGdsError(err);
    if (cls === "gds_missing") {
      return NextResponse.json(
        {
          error: {
            code: "GDS_MISSING",
            message:
              "Neo4j Graph Data Science library not installed on this tier.",
          },
        },
        { status: 501 },
      );
    }
    if (cls === "unreachable") {
      return NextResponse.json(
        { error: { code: "NEO4J_UNREACHABLE", message: "Neo4j unreachable" } },
        { status: 503 },
      );
    }
    console.error("[graph/centrality] error", err);
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "centrality query failed" } },
      { status: 500 },
    );
  }
}

function strOrNull(v: unknown): string | null {
  if (v == null) return null;
  return String(v);
}

function numOf(v: unknown): number {
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
