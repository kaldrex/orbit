import { NextResponse } from "next/server";
import { queryNeo4j } from "@/lib/neo4j";
import { getAuthContext } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!auth.selfNodeId) return NextResponse.json({ nodes: [], links: [], stats: { totalPeople: 0, deals: 0, goingCold: 0 } });

  const { userId, selfNodeId } = auth;

  // All Person nodes for this user
  const personRows = await queryNeo4j(userId,
    `MATCH (p:Person {userId: $userId}) WHERE p.category <> "self"
     RETURN p.id AS id, p.name AS name, p.relationship_score AS score, p.category AS category, p.company AS company, p.last_interaction_at AS lastInteractionAt
     ORDER BY p.relationship_score DESC`
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
    ...personRows.map((r) => ({
      id: r.id as string,
      name: (r.name as string) || (r.id as string),
      score: typeof r.score === "number" ? r.score : parseFloat(r.score as string) || 0,
      category: (r.category as string) || "other",
      company: (r.company as string) || null,
      lastInteractionAt: (r.lastInteractionAt as string) || null,
    })),
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

  return NextResponse.json({
    nodes,
    links,
    stats: { totalPeople: nodes.length - 1, deals: 0, goingCold: goingColdCount },
  });
}
