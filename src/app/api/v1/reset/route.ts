import { NextRequest, NextResponse } from "next/server";
import { writeNeo4j } from "@/lib/neo4j";
import { getAgentOrSessionAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/reset — Delete all graph data for the authenticated user.
 * Keeps the self-node. Requires confirmation body: { confirm: true }
 */
export async function POST(request: NextRequest) {
  const auth = await getAgentOrSessionAuth(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  if (!body.confirm) return NextResponse.json({ error: "Pass { confirm: true } to confirm deletion" }, { status: 400 });

  const { userId, selfNodeId } = auth;

  // Delete all edges first
  await writeNeo4j(userId,
    `MATCH (a:Person {userId: $userId})-[r]-(b:Person {userId: $userId}) DELETE r`
  );

  // Delete all non-self nodes
  await writeNeo4j(userId,
    `MATCH (p:Person {userId: $userId}) WHERE p.category <> "self" DELETE p`
  );

  return NextResponse.json({ ok: true, message: "All contacts and edges deleted. Self-node preserved." });
}
