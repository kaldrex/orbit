import { NextRequest, NextResponse } from "next/server";
import { writeNeo4j, queryNeo4j } from "@/lib/neo4j";
import { getAuthContext } from "@/lib/auth";
import crypto from "crypto";

export const dynamic = "force-dynamic";

/**
 * POST /api/contacts — Create a new Person node
 */
export async function POST(request: NextRequest) {
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { name, company, email, category, score } = body;

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const personId = `p_${crypto.randomUUID().slice(0, 8)}`;
  const { userId, selfNodeId } = auth;

  // Create Person node
  await writeNeo4j(userId,
    `CREATE (p:Person {
      id: $personId,
      userId: $userId,
      name: $name,
      company: $company,
      email: $email,
      category: $category,
      relationship_score: $score,
      last_interaction_at: datetime().epochMillis
    })`,
    {
      personId,
      name: name.trim(),
      company: company?.trim() || null,
      email: email?.trim() || null,
      category: category || "other",
      score: typeof score === "number" ? score : 3,
    }
  );

  // Create INTERACTED edge from self to new person
  if (selfNodeId) {
    await writeNeo4j(userId,
      `MATCH (a:Person {id: $selfNodeId, userId: $userId}), (b:Person {id: $personId, userId: $userId})
       CREATE (a)-[:INTERACTED {channel: "manual", timestamp: datetime(), direction: "outbound", summary: "Added manually"}]->(b)`,
      { selfNodeId, personId }
    );
  }

  return NextResponse.json({ id: personId, name: name.trim() });
}

/**
 * POST /api/contacts/bulk — CSV bulk import
 */
export async function PUT(request: NextRequest) {
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { contacts } = body;

  if (!Array.isArray(contacts) || contacts.length === 0) {
    return NextResponse.json({ error: "No contacts provided" }, { status: 400 });
  }

  if (contacts.length > 500) {
    return NextResponse.json({ error: "Max 500 contacts per import" }, { status: 400 });
  }

  const { userId, selfNodeId } = auth;
  let created = 0;

  for (const c of contacts) {
    if (!c.name || typeof c.name !== "string") continue;

    const personId = `p_${crypto.randomUUID().slice(0, 8)}`;

    await writeNeo4j(userId,
      `CREATE (p:Person {
        id: $personId,
        userId: $userId,
        name: $name,
        company: $company,
        email: $email,
        category: $category,
        relationship_score: $score,
        last_interaction_at: datetime().epochMillis
      })`,
      {
        personId,
        name: c.name.trim(),
        company: c.company?.trim() || null,
        email: c.email?.trim() || null,
        category: c.category || "other",
        score: typeof c.score === "number" ? c.score : 3,
      }
    );

    if (selfNodeId) {
      await writeNeo4j(userId,
        `MATCH (a:Person {id: $selfNodeId, userId: $userId}), (b:Person {id: $personId, userId: $userId})
         CREATE (a)-[:INTERACTED {channel: "import", timestamp: datetime(), direction: "outbound", summary: "Imported via CSV"}]->(b)`,
        { selfNodeId, personId }
      );
    }

    created++;
  }

  return NextResponse.json({ created });
}
