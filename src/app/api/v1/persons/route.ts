import { NextRequest, NextResponse } from "next/server";
import { queryNeo4j } from "@/lib/neo4j";
import { getAgentOrSessionAuth } from "@/lib/api-auth";
import neo4j from "neo4j-driver";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await getAgentOrSessionAuth(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const q = request.nextUrl.searchParams.get("q") || "";
  const limitRaw = parseInt(request.nextUrl.searchParams.get("limit") || "25");
  const limit = Math.max(1, Math.min(limitRaw, 100));
  const category = request.nextUrl.searchParams.get("category");

  // Build query safely — no string interpolation for values
  const whereClauses = ['p.category <> "self"'];
  const params: Record<string, unknown> = { limitVal: neo4j.int(limit) };

  if (q) {
    whereClauses.push('(toLower(p.name) CONTAINS toLower($query) OR toLower(COALESCE(p.company, "")) CONTAINS toLower($query))');
    params.query = q;
  }
  if (category) {
    whereClauses.push("p.category = $category");
    params.category = category;
  }

  const cypher = `MATCH (p:Person {userId: $userId}) WHERE ${whereClauses.join(" AND ")}
    RETURN p.id AS id, p.name AS name, p.company AS company, p.email AS email,
           p.category AS category, p.relationship_score AS score, p.last_interaction_at AS lastInteractionAt
    ORDER BY p.relationship_score DESC LIMIT $limitVal`;

  const rows = await queryNeo4j(auth.userId, cypher, params);

  const persons = rows.map((r) => ({
    id: r.id as string,
    name: (r.name as string) || (r.id as string),
    company: (r.company as string) || null,
    email: (r.email as string) || null,
    category: (r.category as string) || "other",
    score: typeof r.score === "number" ? r.score : 0,
    lastInteractionAt: (r.lastInteractionAt as string) || null,
  }));

  return NextResponse.json({ persons, count: persons.length });
}
