import { NextRequest, NextResponse } from "next/server";
import { writeNeo4j } from "@/lib/neo4j";
import { getAgentOrSessionAuth } from "@/lib/api-auth";
import { createHash } from "crypto";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/reset — Delete all graph data for the authenticated user.
 * Requires: { confirm: "DELETE_ALL_MY_DATA" }
 * Only callable with session auth (not API keys) for extra safety.
 */
export async function POST(request: NextRequest) {
  // Session auth only — API keys cannot reset data
  const { getAuthContext } = await import("@/lib/auth");
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: "Unauthorized. Session auth required — API keys cannot reset data." }, { status: 401 });

  const body = await request.json();
  if (body.confirm !== "DELETE_ALL_MY_DATA") {
    return NextResponse.json({
      error: "Pass { confirm: \"DELETE_ALL_MY_DATA\" } to confirm. This is irreversible.",
    }, { status: 400 });
  }

  const { userId } = auth;

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
