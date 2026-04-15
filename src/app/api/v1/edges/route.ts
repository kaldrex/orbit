import { NextRequest, NextResponse } from "next/server";
import { writeNeo4j } from "@/lib/neo4j";
import { getAgentOrSessionAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/edges — create KNOWS edges between persons
 *
 * Used by agents when they observe co-presence: two contacts in the same
 * email CC, calendar invite, Slack thread, or meeting.
 *
 * Body:
 * {
 *   edges: [
 *     { from: "person_id_1", to: "person_id_2", source?: "email_cc" | "calendar" | "slack_thread" | ... }
 *   ]
 * }
 *
 * OR shorthand for names (agent resolves or creates):
 * {
 *   edges: [
 *     { fromName: "Jane Smith", toName: "Bob Chen", source?: "calendar" }
 *   ]
 * }
 */
export async function POST(request: NextRequest) {
  const auth = await getAgentOrSessionAuth(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { edges = [] } = body;

  if (!Array.isArray(edges) || edges.length === 0) {
    return NextResponse.json({ error: "No edges provided" }, { status: 400 });
  }

  const { userId } = auth;
  let created = 0;

  for (const edge of edges) {
    let fromId = edge.from;
    let toId = edge.to;

    // Resolve names to IDs if needed
    if (!fromId && edge.fromName) {
      const rows = await import("@/lib/neo4j").then(m =>
        m.queryNeo4j(userId,
          `MATCH (p:Person {userId: $userId}) WHERE toLower(p.name) = toLower($name) RETURN p.id AS id LIMIT 1`,
          { name: edge.fromName.trim() }
        )
      );
      fromId = rows[0]?.id;
    }

    if (!toId && edge.toName) {
      const rows = await import("@/lib/neo4j").then(m =>
        m.queryNeo4j(userId,
          `MATCH (p:Person {userId: $userId}) WHERE toLower(p.name) = toLower($name) RETURN p.id AS id LIMIT 1`,
          { name: edge.toName.trim() }
        )
      );
      toId = rows[0]?.id;
    }

    if (!fromId || !toId) continue;

    await writeNeo4j(userId,
      `MATCH (a:Person {id: $fromId, userId: $userId}), (b:Person {id: $toId, userId: $userId})
       MERGE (a)-[:KNOWS {source: $source}]->(b)`,
      { fromId, toId, source: edge.source || "co-presence" }
    );
    created++;
  }

  return NextResponse.json({ ok: true, created });
}
