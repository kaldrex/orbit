import { NextRequest, NextResponse } from "next/server";
import { writeNeo4j, queryNeo4j } from "@/lib/neo4j";
import { getAgentOrSessionAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/ingest
 *
 * Bulk ingestion endpoint for agents. Accepts a batch of observed interactions
 * and creates/updates Person nodes + INTERACTED edges + KNOWS edges.
 *
 * This is the primary write path — agents call this after observing conversations.
 *
 * Body:
 * {
 *   interactions: [{
 *     participants: ["Jane Smith", "Bob Chen"],  // names observed in conversation
 *     channel: "slack" | "whatsapp" | "telegram" | "email" | "imessage" | "meeting" | ...,
 *     summary?: "Discussed fundraising timeline",
 *     topic?: "fundraising",
 *     timestamp?: "2026-04-15T10:00:00Z",
 *     metadata?: { thread_id: "...", channel_name: "..." }
 *   }],
 *   persons?: [{
 *     name: "Jane Smith",
 *     company?: "Acme Corp",
 *     email?: "jane@acme.com",
 *     category?: "investor",
 *     title?: "Partner"
 *   }]
 * }
 */
export async function POST(request: NextRequest) {
  const auth = await getAgentOrSessionAuth(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!auth.selfNodeId) return NextResponse.json({ error: "User not initialized — call POST /api/init first" }, { status: 400 });

  const body = await request.json();
  const { interactions = [], persons = [] } = body;

  const { userId, selfNodeId } = auth;
  const stats = { personsCreated: 0, personsUpdated: 0, interactionsCreated: 0, edgesCreated: 0 };

  // Upsert person metadata if provided
  for (const p of persons) {
    if (!p.name) continue;

    const existing = await queryNeo4j(userId,
      `MATCH (p:Person {userId: $userId}) WHERE toLower(p.name) = toLower($name) RETURN p.id AS id LIMIT 1`,
      { name: p.name.trim() }
    );

    if (existing.length > 0) {
      // Update with new info
      const sets: string[] = [];
      const params: Record<string, unknown> = { personId: existing[0].id };
      if (p.company) { sets.push("p.company = $company"); params.company = p.company; }
      if (p.email) { sets.push("p.email = $email"); params.email = p.email; }
      if (p.category) { sets.push("p.category = $category"); params.category = p.category; }
      if (p.title) { sets.push("p.title = $title"); params.title = p.title; }

      if (sets.length > 0) {
        await writeNeo4j(userId,
          `MATCH (p:Person {id: $personId, userId: $userId}) SET ${sets.join(", ")}`,
          params
        );
        stats.personsUpdated++;
      }
    } else {
      // Create new person
      const personId = `p_${crypto.randomUUID().slice(0, 8)}`;
      await writeNeo4j(userId,
        `CREATE (p:Person {
          id: $personId, userId: $userId, name: $name,
          company: $company, email: $email, category: $category,
          title: $title, relationship_to_me: $relationshipToMe,
          relationship_score: 1, source: "agent"
        })`,
        {
          personId,
          name: p.name.trim(),
          company: p.company || null,
          email: p.email || null,
          category: p.category || "other",
          title: p.title || null,
          relationshipToMe: p.relationship_to_me || null,
        }
      );
      stats.personsCreated++;
    }
  }

  // Process interactions
  for (const ix of interactions) {
    if (!ix.participants || !Array.isArray(ix.participants) || ix.participants.length === 0) continue;

    const resolvedIds: string[] = [];

    for (const name of ix.participants) {
      if (!name || typeof name !== "string") continue;

      // Resolve or create person
      const existing = await queryNeo4j(userId,
        `MATCH (p:Person {userId: $userId}) WHERE toLower(p.name) = toLower($name) AND p.category <> "self" RETURN p.id AS id LIMIT 1`,
        { name: name.trim() }
      );

      let personId: string;
      if (existing.length > 0) {
        personId = existing[0].id as string;
      } else {
        personId = `p_${crypto.randomUUID().slice(0, 8)}`;
        await writeNeo4j(userId,
          `CREATE (p:Person {
            id: $personId, userId: $userId, name: $name,
            category: "other", relationship_score: 1, source: "agent"
          })`,
          { personId, name: name.trim() }
        );
        stats.personsCreated++;
      }

      resolvedIds.push(personId);

      // Create INTERACTED edge from self to this person
      await writeNeo4j(userId,
        `MATCH (a:Person {id: $selfNodeId, userId: $userId}), (b:Person {id: $personId, userId: $userId})
         CREATE (a)-[:INTERACTED {
           channel: $channel,
           timestamp: $timestamp,
           summary: $summary,
           topic_summary: $topic,
           relationship_context: $relationshipContext,
           sentiment: $sentiment
         }]->(b)`,
        {
          selfNodeId,
          personId,
          channel: ix.channel || "unknown",
          timestamp: ix.timestamp || new Date().toISOString(),
          summary: ix.summary || null,
          topic: ix.topic || null,
          relationshipContext: ix.relationship_context || null,
          sentiment: ix.sentiment || null,
        }
      );
      stats.interactionsCreated++;

      // Update last_interaction_at and bump score
      await writeNeo4j(userId,
        `MATCH (p:Person {id: $personId, userId: $userId})
         SET p.last_interaction_at = datetime().epochMillis,
             p.relationship_score = CASE
               WHEN p.relationship_score < 10
               THEN p.relationship_score + 0.1
               ELSE p.relationship_score
             END`,
        { personId }
      );
    }

    // If multiple participants, create KNOWS edges between them with context
    if (resolvedIds.length >= 2) {
      for (let i = 0; i < resolvedIds.length; i++) {
        for (let j = i + 1; j < resolvedIds.length; j++) {
          await writeNeo4j(userId,
            `MATCH (a:Person {id: $idA, userId: $userId}), (b:Person {id: $idB, userId: $userId})
             MERGE (a)-[r:KNOWS]->(b)
             ON CREATE SET r.source = $channel, r.context = $context, r.created_at = datetime()
             ON MATCH SET r.context = CASE WHEN $context IS NOT NULL AND r.context IS NOT NULL THEN r.context + " | " + $context WHEN $context IS NOT NULL THEN $context ELSE r.context END`,
            {
              idA: resolvedIds[i],
              idB: resolvedIds[j],
              channel: ix.channel || "co-presence",
              context: ix.connection_context || ix.summary || null,
            }
          );
          stats.edgesCreated++;
        }
      }
    }
  }

  return NextResponse.json({ ok: true, stats });
}
