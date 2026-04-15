import { NextRequest, NextResponse } from "next/server";
import { writeNeo4j } from "@/lib/neo4j";
import { getAgentOrSessionAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/persons/:id/interactions — log a single interaction
 *
 * Body:
 * {
 *   channel: "slack" | "whatsapp" | "email" | "meeting" | ...,
 *   summary?: "Discussed fundraising timeline",
 *   topic?: "fundraising",
 *   direction?: "inbound" | "outbound" | "both",
 *   timestamp?: "2026-04-15T10:00:00Z"
 * }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAgentOrSessionAuth(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!auth.selfNodeId) return NextResponse.json({ error: "User not initialized" }, { status: 400 });

  const { id } = await params;
  const body = await request.json();

  await writeNeo4j(auth.userId,
    `MATCH (a:Person {id: $selfNodeId, userId: $userId}), (b:Person {id: $personId, userId: $userId})
     CREATE (a)-[:INTERACTED {
       channel: $channel,
       timestamp: $timestamp,
       direction: $direction,
       summary: $summary,
       topic_summary: $topic
     }]->(b)`,
    {
      selfNodeId: auth.selfNodeId,
      personId: id,
      channel: body.channel || "unknown",
      timestamp: body.timestamp || new Date().toISOString(),
      direction: body.direction || "both",
      summary: body.summary || null,
      topic: body.topic || null,
    }
  );

  // Bump score + update last_interaction_at
  await writeNeo4j(auth.userId,
    `MATCH (p:Person {id: $personId, userId: $userId})
     SET p.last_interaction_at = datetime().epochMillis,
         p.relationship_score = CASE WHEN p.relationship_score < 10 THEN p.relationship_score + 0.1 ELSE p.relationship_score END`,
    { personId: id }
  );

  return NextResponse.json({ ok: true });
}
