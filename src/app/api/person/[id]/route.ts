import { NextRequest, NextResponse } from "next/server";
import { queryNeo4j } from "@/lib/neo4j";
import { getAuthContext } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!id || id.length > 100) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const { userId, selfNodeId } = auth;

  // Person profile
  const personRows = await queryNeo4j(userId,
    `MATCH (p:Person {id: $personId, userId: $userId}) RETURN p`,
    { personId: id }
  );

  if (personRows.length === 0) return NextResponse.json({ error: "Person not found" }, { status: 404 });

  const p = personRows[0].p as Record<string, unknown>;

  const profile = {
    id: p.id || id,
    name: p.name || null,
    company: p.company || null,
    title: p.title || null,
    email: p.email || null,
    phone: p.phone || null,
    whatsappJid: p.whatsapp_jid || null,
    score: typeof p.relationship_score === "number" ? p.relationship_score : parseFloat(p.relationship_score as string) || 0,
    category: p.category || null,
    location: p.location || null,
    lastInteractionAt: p.last_interaction_at || null,
  };

  // Interaction timeline
  const interactionRows = selfNodeId ? await queryNeo4j(userId,
    `MATCH (a:Person {id: $selfNodeId, userId: $userId})-[r:INTERACTED]-(p:Person {id: $personId, userId: $userId})
     RETURN r.channel AS channel, r.timestamp AS timestamp, r.direction AS direction, r.summary AS summary, r.topic_summary AS topicSummary
     ORDER BY r.timestamp DESC`,
    { selfNodeId, personId: id }
  ) : [];

  const interactions = interactionRows.map((r) => ({
    channel: r.channel || null,
    timestamp: r.timestamp || null,
    direction: r.direction || null,
    summary: r.summary || null,
    topic_summary: r.topicSummary || null,
  }));

  // Shared connections
  const sharedRows = selfNodeId ? await queryNeo4j(userId,
    `MATCH (h:Person {id: $selfNodeId, userId: $userId})-[:INTERACTED]-(c:Person {userId: $userId})-[:KNOWS]-(b:Person {id: $personId, userId: $userId})
     WHERE c.id <> $selfNodeId AND c.id <> $personId
     RETURN DISTINCT c.id AS id, c.name AS name LIMIT 20`,
    { selfNodeId, personId: id }
  ) : [];

  const sharedConnections = sharedRows.map((r) => ({
    id: r.id as string,
    name: (r.name as string) || (r.id as string),
  }));

  return NextResponse.json({ profile, interactions, sharedConnections });
}
