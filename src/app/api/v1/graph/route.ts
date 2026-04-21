import { NextResponse } from "next/server";
import neo4j from "neo4j-driver";
import { getAgentOrSessionAuth } from "@/lib/api-auth";
import { withReadSession } from "@/lib/neo4j";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface GraphNode {
  id: string;
  name: string;
  score: number;
  category: string;
  company: string | null;
  lastInteractionAt: string | null;
}

interface GraphLink {
  source: string;
  target: string;
  weight: number;
  type: string;
}

interface GraphStats {
  totalPeople: number;
  goingCold: number;
}

const EMPTY_PAYLOAD = {
  nodes: [] as GraphNode[],
  links: [] as GraphLink[],
  stats: { totalPeople: 0, goingCold: 0 } as GraphStats,
};

type Neo4jInteger = { toNumber: () => number };

function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  if (neo4j.isInt(value as Neo4jInteger)) return (value as Neo4jInteger).toNumber();
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof value === "object" && value !== null && "toNumber" in (value as object)) {
    try { return (value as Neo4jInteger).toNumber(); } catch { return 0; }
  }
  return 0;
}

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  // Neo4j DateTime has a toString() that produces an ISO8601-ish string.
  if (typeof value === "object" && value !== null && "toString" in (value as object)) {
    try {
      const s = String(value);
      return s.length > 0 ? s : null;
    } catch { return null; }
  }
  return null;
}

function toStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  return String(value);
}

/**
 * GET /api/v1/graph
 *
 * Returns the authenticated user's Neo4j-projected person graph in the
 * shape the dashboard's Reagraph canvas consumes.
 *
 * Response: { nodes: GraphNode[], links: GraphLink[], stats: { totalPeople, goingCold } }
 *
 * Graceful degradation: if Neo4j is empty OR unreachable, returns HTTP 200
 * with empty arrays and zeroed stats, and logs a warning. The dashboard
 * pre-populate path relies on this — it must not error-state before the
 * `POST /api/v1/graph/populate` companion has run.
 */
export async function GET(request: Request) {
  const auth = await getAgentOrSessionAuth(request);
  if (!auth) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 },
    );
  }

  try {
    const { nodes, links, stats } = await withReadSession(async (session) => {
      const nodeResult = await session.run(
        `MATCH (p:Person {user_id: $userId})
         RETURN p.id AS id,
                p.name AS name,
                p.category AS category,
                p.company AS company,
                p.last_interaction_at AS lastInteractionAt,
                p.score AS score`,
        { userId: auth.userId },
      );

      const nodes: GraphNode[] = nodeResult.records.map((r) => ({
        id: String(r.get("id")),
        name: toStringOrNull(r.get("name")) ?? "",
        score: toNumber(r.get("score")),
        category: toStringOrNull(r.get("category")) ?? "other",
        company: toStringOrNull(r.get("company")),
        lastInteractionAt: toIso(r.get("lastInteractionAt")),
      }));

      const linkResult = await session.run(
        `MATCH (a:Person {user_id: $userId})-[r]-(b:Person {user_id: $userId})
         WHERE id(a) < id(b)
         RETURN a.id AS source, b.id AS target, r.weight AS weight, type(r) AS type`,
        { userId: auth.userId },
      );

      const links: GraphLink[] = linkResult.records.map((r) => ({
        source: String(r.get("source")),
        target: String(r.get("target")),
        weight: toNumber(r.get("weight")),
        type: toStringOrNull(r.get("type")) ?? "interacted",
      }));

      const goingColdResult = await session.run(
        `MATCH (p:Person {user_id: $userId})
         WHERE p.last_interaction_at IS NOT NULL
           AND datetime(p.last_interaction_at) < datetime() - duration('P14D')
           AND p.score > 2
         RETURN count(p) AS going_cold`,
        { userId: auth.userId },
      );
      const goingCold = toNumber(goingColdResult.records[0]?.get("going_cold"));

      const totalResult = await session.run(
        `MATCH (p:Person {user_id: $userId}) RETURN count(p) AS total`,
        { userId: auth.userId },
      );
      const totalPeople = toNumber(totalResult.records[0]?.get("total"));

      return { nodes, links, stats: { totalPeople, goingCold } };
    });

    return NextResponse.json({ nodes, links, stats });
  } catch (err) {
    console.warn(
      "[api/v1/graph] Neo4j read failed; returning empty graph",
      err,
    );
    return NextResponse.json(EMPTY_PAYLOAD);
  }
}
