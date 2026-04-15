import { NextRequest, NextResponse } from "next/server";
import { queryNeo4j, writeNeo4j } from "@/lib/neo4j";
import { getAgentOrSessionAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/persons/:id — full person card (profile + interactions + connections)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAgentOrSessionAuth(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const { userId, selfNodeId } = auth;

  const rows = await queryNeo4j(userId,
    `MATCH (p:Person {id: $personId, userId: $userId}) RETURN p`,
    { personId: id }
  );

  if (rows.length === 0) return NextResponse.json({ error: "Person not found" }, { status: 404 });

  const p = rows[0].p as Record<string, unknown>;

  const profile = {
    id: p.id, name: p.name, company: p.company || null, title: p.title || null,
    email: p.email || null, phone: p.phone || null,
    score: p.relationship_score || 0, category: p.category || "other",
    lastInteractionAt: p.last_interaction_at || null,
  };

  // Recent interactions
  const interactionRows = selfNodeId ? await queryNeo4j(userId,
    `MATCH (a:Person {id: $selfNodeId, userId: $userId})-[r:INTERACTED]-(p:Person {id: $personId, userId: $userId})
     RETURN r.channel AS channel, r.timestamp AS timestamp, r.summary AS summary, r.topic_summary AS topic
     ORDER BY r.timestamp DESC LIMIT 30`,
    { selfNodeId, personId: id }
  ) : [];

  // Shared connections
  const sharedRows = selfNodeId ? await queryNeo4j(userId,
    `MATCH (h:Person {id: $selfNodeId, userId: $userId})-[:INTERACTED]-(c:Person {userId: $userId})-[:KNOWS]-(b:Person {id: $personId, userId: $userId})
     WHERE c.id <> $selfNodeId AND c.id <> $personId
     RETURN DISTINCT c.id AS id, c.name AS name LIMIT 20`,
    { selfNodeId, personId: id }
  ) : [];

  return NextResponse.json({
    profile,
    interactions: interactionRows.map((r) => ({
      channel: r.channel, timestamp: r.timestamp, summary: r.summary, topic: r.topic,
    })),
    sharedConnections: sharedRows.map((r) => ({ id: r.id, name: r.name })),
  });
}

/**
 * PATCH /api/v1/persons/:id — update person metadata
 * Body: { name?, company?, email?, category?, title?, score? }
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAgentOrSessionAuth(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await request.json();

  const sets: string[] = [];
  const p: Record<string, unknown> = { personId: id };

  if (body.name) { sets.push("p.name = $name"); p.name = body.name; }
  if (body.company) { sets.push("p.company = $company"); p.company = body.company; }
  if (body.email) { sets.push("p.email = $email"); p.email = body.email; }
  if (body.category) { sets.push("p.category = $category"); p.category = body.category; }
  if (body.title) { sets.push("p.title = $title"); p.title = body.title; }
  if (typeof body.score === "number") { sets.push("p.relationship_score = $score"); p.score = body.score; }

  if (sets.length === 0) return NextResponse.json({ error: "No fields to update" }, { status: 400 });

  await writeNeo4j(auth.userId,
    `MATCH (p:Person {id: $personId, userId: $userId}) SET ${sets.join(", ")}`,
    p
  );

  return NextResponse.json({ ok: true });
}
