import { NextResponse } from "next/server";
import { queryNeo4j } from "@/lib/neo4j";
import { getAuthContext } from "@/lib/auth";
import { scorePersonFromEdges } from "@/lib/scoring";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!auth.selfNodeId) return NextResponse.json({ nodes: [], links: [], stats: { totalPeople: 0, deals: 0, goingCold: 0 } });

  const { userId, selfNodeId } = auth;

  // All Person nodes with per-edge interaction data for real scoring.
  // The WHERE clause filters out orphan nodes (zero connections).
  const personRows = await queryNeo4j(userId,
    `MATCH (p:Person {userId: $userId}) WHERE p.category <> "self"
     OPTIONAL MATCH (self:Person {id: $selfNodeId, userId: $userId})-[i:INTERACTED]-(p)
     OPTIONAL MATCH (p)-[k:KNOWS]-(:Person {userId: $userId})
     WITH p,
          collect(DISTINCT {channel: i.channel, timestamp: i.timestamp}) AS interactions,
          count(DISTINCT k) AS knowsCount
     WHERE size(interactions) > 0 OR knowsCount > 0
     RETURN p.id AS id, p.name AS name, p.category AS category,
            p.company AS company, p.last_interaction_at AS lastInteractionAt,
            interactions, knowsCount
     ORDER BY size(interactions) + knowsCount DESC`,
    { selfNodeId }
  );

  const nodes = [
    {
      id: selfNodeId,
      name: auth.displayName,
      score: 10,
      category: "self",
      company: null,
      lastInteractionAt: null,
    },
    ...personRows.map((r) => {
      // Filter out null interactions from the OPTIONAL MATCH (Neo4j returns [{channel: null, timestamp: null}] when no match)
      const interactions = (r.interactions as { channel: string; timestamp: string }[])
        .filter((ix) => ix.channel != null && ix.timestamp != null);
      const knowsCount = typeof r.knowsCount === "number" ? r.knowsCount : parseInt(r.knowsCount as string, 10) || 0;

      const score = scorePersonFromEdges(interactions, knowsCount);

      return {
        id: r.id as string,
        name: (r.name as string) || (r.id as string),
        score,
        category: (r.category as string) || "other",
        company: (r.company as string) || null,
        lastInteractionAt: (r.lastInteractionAt as string) || null,
      };
    }),
  ];

  const nodeIds = new Set(nodes.map((n) => n.id));

  // INTERACTED edges (self <-> Person)
  const edgeRows = await queryNeo4j(userId,
    `MATCH (a:Person {id: $selfNodeId, userId: $userId})-[r:INTERACTED]-(b:Person {userId: $userId})
     RETURN b.id AS targetId, count(r) AS weight ORDER BY weight DESC`,
    { selfNodeId }
  );

  const links = edgeRows
    .filter((r) => nodeIds.has(r.targetId as string))
    .map((r) => ({
      source: selfNodeId,
      target: r.targetId as string,
      weight: typeof r.weight === "number" ? r.weight : parseInt(r.weight as string, 10) || 1,
      type: "interacted",
    }));

  // KNOWS cross-connections
  const knowsRows = await queryNeo4j(userId,
    `MATCH (a:Person {userId: $userId})-[r:KNOWS]->(b:Person {userId: $userId})
     RETURN a.id AS sourceId, b.id AS targetId`
  );

  for (const r of knowsRows) {
    const src = r.sourceId as string;
    const tgt = r.targetId as string;
    if (nodeIds.has(src) && nodeIds.has(tgt)) {
      links.push({ source: src, target: tgt, weight: 1, type: "knows" });
    }
  }

  // Going cold count
  const now = Date.now();
  const fourteenDays = 14 * 24 * 60 * 60 * 1000;
  const goingColdCount = nodes.filter((n) => {
    if (n.category === "self" || n.score <= 5 || !n.lastInteractionAt) return false;
    try { return now - Date.parse(n.lastInteractionAt) > fourteenDays; } catch { return false; }
  }).length;

  // Warm contacts = score >= 5 (excluding self)
  const warmContactsCount = nodes.filter(
    (n) => n.category !== "self" && n.score >= 5
  ).length;

  // Total INTERACTED edge count across this user's graph
  const [interactedRow] = await queryNeo4j(userId,
    `MATCH (:Person {userId: $userId})-[r:INTERACTED]-(:Person {userId: $userId})
     RETURN count(r) AS total`
  );
  const totalInteractions = typeof interactedRow?.total === "number"
    ? interactedRow.total
    : parseInt((interactedRow?.total as string) ?? "0", 10) || 0;
  // Neo4j counts each edge twice in an undirected MATCH — halve it
  const normalizedInteractions = Math.floor(totalInteractions / 2);

  return NextResponse.json({
    nodes,
    links,
    stats: {
      totalPeople: nodes.length - 1,
      totalInteractions: normalizedInteractions,
      warmContacts: warmContactsCount,
      goingCold: goingColdCount,
      deals: 0,
    },
  });
}
