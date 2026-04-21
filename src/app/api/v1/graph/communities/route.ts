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

interface Community {
  id: number;
  size: number;
  member_ids: string[];
  top_names: string[];
}

/**
 * GET /api/v1/graph/communities
 *
 * Leiden clustering over the user's DM / SHARED_GROUP / EMAILED
 * subgraph. Chosen over Louvain per Traag (2019) — Leiden strictly
 * dominates on partition quality + stability.
 *
 * Deterministic: `randomSeed: 42` so repeated calls return the same
 * community ids (crucial for UI that colours persons by community).
 *
 * Response: { communities: [{id, size, member_ids, top_names}, ...] }
 *   - Communities with size < 2 are dropped (singleton = noise).
 *   - Sorted by size desc.
 *   - `top_names` is up to 5 names, preferring named persons over
 *     placeholders.
 *
 * Errors: 501 GDS_MISSING / 503 NEO4J_UNREACHABLE (see classifyGdsError).
 * Empty graph → 200 with { communities: [] }.
 */
export async function GET(request: Request) {
  const auth = await getAgentOrSessionAuth(request);
  if (!auth) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 },
    );
  }

  const name = graphName(auth.userId, "leiden");

  try {
    const communities = await withReadSession(async (session) => {
      const { edges } = await projectUserGraph(session, name, auth.userId);

      // Empty graph → nothing to cluster.
      if (edges === 0) {
        await dropIfExists(session, name).catch(() => {});
        return [];
      }

      try {
        const res = await session.run(
          `CALL gds.leiden.stream($graphName, {
             relationshipWeightProperty: 'weight',
             randomSeed: 42
           })
           YIELD nodeId, communityId
           WITH communityId, collect(nodeId) AS internalIds
           WHERE size(internalIds) >= 2
           UNWIND internalIds AS nid
           MATCH (p:Person) WHERE id(p) = nid AND p.user_id = $uid
           WITH communityId, collect({id: p.id, name: p.name}) AS members
           RETURN communityId AS id, size(members) AS sz, members
           ORDER BY sz DESC`,
          { graphName: name, uid: auth.userId },
        );

        const out: Community[] = res.records.map((r) => {
          const members = (r.get("members") as Array<{ id: string; name: string | null }>) ?? [];
          const memberIds = members.map((m) => String(m.id));
          const named = members
            .filter((m) => m.name && !/^\+?\d+$/.test(m.name))
            .map((m) => String(m.name));
          const top = (named.length > 0 ? named : members.map((m) => String(m.name ?? m.id))).slice(0, 5);
          return {
            id: numOf(r.get("id")),
            size: numOf(r.get("sz")),
            member_ids: memberIds,
            top_names: top,
          };
        });
        return out;
      } finally {
        await dropIfExists(session, name).catch(() => {});
      }
    });

    return NextResponse.json({ communities });
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
    console.error("[graph/communities] error", err);
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "communities query failed" } },
      { status: 500 },
    );
  }
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
