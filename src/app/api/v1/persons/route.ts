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
  // When the identity resolver or categorizer is iterating the full graph,
  // they need a wider cap. Default stays small (25) for user search; batch
  // consumers pass limit up to 500.
  const limit = Math.max(1, Math.min(limitRaw, 500));
  const category = request.nextUrl.searchParams.get("category");
  // Cursor-based pagination. The cursor is the last id returned; results
  // are ordered by id for stable paging.
  const cursor = request.nextUrl.searchParams.get("cursor");
  // When order=id, paginate by id (for resolver/categorizer full scans).
  // Default order=score keeps the existing user-search behavior.
  const order = (request.nextUrl.searchParams.get("order") || "score") === "id"
    ? "id"
    : "score";

  // Batch consumers (identity resolver self-dedup, future passes) need the
  // self node in the results. Default behavior still hides self for UX
  // reads (the dashboard doesn't want its own node in search results).
  const includeSelf = request.nextUrl.searchParams.get("include_self") === "true";
  const whereClauses = includeSelf ? ["true"] : ['p.category <> "self"'];
  const params: Record<string, unknown> = { limitVal: neo4j.int(limit) };

  if (q) {
    whereClauses.push('(toLower(p.name) CONTAINS toLower($query) OR toLower(COALESCE(p.company, "")) CONTAINS toLower($query))');
    params.query = q;
  }
  if (category) {
    whereClauses.push("p.category = $category");
    params.category = category;
  }
  if (cursor && order === "id") {
    whereClauses.push("p.id > $cursor");
    params.cursor = cursor;
  }

  const orderClause = order === "id" ? "p.id ASC" : "p.relationship_score DESC";

  const cypher = `MATCH (p:Person {userId: $userId}) WHERE ${whereClauses.join(" AND ")}
    RETURN p.id AS id, p.name AS name, p.company AS company, p.email AS email,
           p.phone AS phone, p.category AS category, p.aliases AS aliases,
           p.relationship_score AS score, p.last_interaction_at AS lastInteractionAt
    ORDER BY ${orderClause} LIMIT $limitVal`;

  const rows = await queryNeo4j(auth.userId, cypher, params);

  const persons = rows.map((r) => ({
    id: r.id as string,
    name: (r.name as string) || (r.id as string),
    company: (r.company as string) || null,
    email: (r.email as string) || null,
    phone: (r.phone as string) || null,
    category: (r.category as string) || "other",
    aliases: Array.isArray(r.aliases) ? (r.aliases as string[]) : null,
    score: typeof r.score === "number" ? r.score : 0,
    lastInteractionAt: (r.lastInteractionAt as string) || null,
  }));

  const nextCursor =
    order === "id" && persons.length === limit
      ? persons[persons.length - 1].id
      : null;

  return NextResponse.json({ persons, count: persons.length, nextCursor });
}
