import { NextRequest, NextResponse } from "next/server";
import { queryNeo4j } from "@/lib/neo4j";
import { getAgentOrSessionAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/search?q=<query>&limit=<n>
 *
 * Searches the relationship graph for people matching a query across name,
 * company, email, and title. Returns direct matches ranked by relevance and
 * warmth score, plus intro paths (up to length 2) from the user's self-node
 * for anyone the user doesn't directly interact with.
 *
 * This powers the `orbit_network_search` tool ("who do I know at Anthropic?").
 */
export async function GET(request: NextRequest) {
  const auth = await getAgentOrSessionAuth(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!auth.selfNodeId) return NextResponse.json({ matches: [], introPaths: [] });

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 10), 50);
  if (!q) return NextResponse.json({ error: "Missing query" }, { status: 400 });

  const { userId, selfNodeId } = auth;

  // Direct matches: fuzzy across name, company, email, title
  const lowerQ = q.toLowerCase();
  const matches = await queryNeo4j(userId,
    `MATCH (p:Person {userId: $userId}) WHERE p.category <> "self"
       AND (
         toLower(p.name) CONTAINS $q
         OR toLower(coalesce(p.company, "")) CONTAINS $q
         OR toLower(coalesce(p.email, "")) CONTAINS $q
         OR toLower(coalesce(p.title, "")) CONTAINS $q
       )
     OPTIONAL MATCH (self:Person {id: $selfNodeId, userId: $userId})-[i:INTERACTED]-(p)
     WITH p, count(i) as directEdges
     RETURN p.id AS id, p.name AS name, p.company AS company, p.email AS email,
            p.title AS title, p.category AS category, directEdges
     ORDER BY directEdges DESC, p.name
     LIMIT $limit`,
    { q: lowerQ, selfNodeId, limit }
  );

  const directIds = new Set(matches.filter((m) => (m.directEdges as number) > 0).map((m) => m.id));

  // For matches the user doesn't directly know, find shortest intro path
  // through KNOWS edges from self (length 2: self → introducer → target)
  const introTargets = matches.filter((m) => !directIds.has(m.id as string));
  const introPaths: Array<{ targetId: string; targetName: string; path: Array<{ id: string; name: string }> }> = [];

  if (introTargets.length > 0) {
    const targetIds = introTargets.map((t) => t.id);
    const pathRows = await queryNeo4j(userId,
      `MATCH (self:Person {id: $selfNodeId, userId: $userId})
       UNWIND $targets AS tid
       MATCH (target:Person {id: tid, userId: $userId})
       OPTIONAL MATCH path = shortestPath((self)-[:KNOWS|INTERACTED*..3]-(target))
       WITH target, path WHERE path IS NOT NULL
       RETURN target.id AS targetId,
              target.name AS targetName,
              [n IN nodes(path) | {id: n.id, name: n.name}] AS nodes`,
      { selfNodeId, targets: targetIds }
    );

    for (const row of pathRows) {
      introPaths.push({
        targetId: row.targetId as string,
        targetName: row.targetName as string,
        path: row.nodes as Array<{ id: string; name: string }>,
      });
    }
  }

  return NextResponse.json({
    query: q,
    matches: matches.map((m) => ({
      id: m.id,
      name: m.name,
      company: m.company,
      email: m.email,
      title: m.title,
      category: m.category,
      directlyKnown: (m.directEdges as number) > 0,
    })),
    introPaths,
  });
}
