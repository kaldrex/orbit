import { NextRequest, NextResponse } from "next/server";
import { queryNeo4j } from "@/lib/neo4j";
import { getAuthContext } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const q = request.nextUrl.searchParams.get("q");
  if (!q || q.trim().length === 0) return NextResponse.json({ results: [] });
  if (q.length > 200) return NextResponse.json({ error: "Query too long" }, { status: 400 });

  const rows = await queryNeo4j(auth.userId,
    `MATCH (p:Person {userId: $userId})
     WHERE toLower(p.name) CONTAINS toLower($query)
        OR toLower(p.company) CONTAINS toLower($query)
     RETURN p.id AS id, p.name AS name, p.company AS company, p.relationship_score AS score
     ORDER BY p.relationship_score DESC LIMIT 25`,
    { query: q.trim() }
  );

  const results = rows.map((r) => ({
    id: r.id as string,
    name: (r.name as string) || (r.id as string),
    company: (r.company as string) || null,
    score: typeof r.score === "number" ? r.score : parseFloat(r.score as string) || 0,
  }));

  return NextResponse.json({ results });
}
