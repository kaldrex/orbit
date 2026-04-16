import { NextRequest, NextResponse } from "next/server";
import {
  batchUpsertPersons,
  batchResolveParticipants,
  batchCreateInteractions,
  batchMergeKnows,
  type PersonBatchItem,
  type InteractionBatchItem,
  type KnowsBatchItem,
} from "@/lib/neo4j";
import { getAgentOrSessionAuth } from "@/lib/api-auth";
import { waitUntil } from "@vercel/functions";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CHUNK_SIZE = 20;

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * POST /api/v1/ingest
 *
 * Bulk ingestion endpoint for agents. Accepts a batch of observed interactions
 * and creates/updates Person nodes + INTERACTED edges + KNOWS edges.
 *
 * Returns immediately with accepted counts. Processing runs in background
 * via waitUntil (Vercel) or awaited directly (local dev).
 *
 * Body:
 * {
 *   interactions: [{
 *     participants: ["Jane Smith", "Bob Chen"],
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

  // Return accepted counts immediately
  const accepted = {
    persons: persons.filter((p: { name?: string }) => p.name).length,
    interactions: interactions.filter(
      (ix: { participants?: unknown }) =>
        Array.isArray(ix.participants) && ix.participants.length > 0
    ).length,
  };

  const promise = processIngest(userId, selfNodeId, persons, interactions);

  // waitUntil runs the promise in the background on Vercel.
  // In local dev (next dev), waitUntil throws — fall back to await.
  try {
    waitUntil(promise);
  } catch {
    await promise;
  }

  return NextResponse.json({
    ok: true,
    accepted,
    // Backward compat: old callers may read stats
    stats: { personsCreated: 0, personsUpdated: 0, interactionsCreated: accepted.interactions, edgesCreated: 0 },
  });
}

async function processIngest(
  userId: string,
  selfNodeId: string,
  persons: Array<{
    name?: string;
    company?: string;
    email?: string;
    category?: string;
    title?: string;
    relationship_to_me?: string;
  }>,
  interactions: Array<{
    participants?: string[];
    channel?: string;
    summary?: string;
    topic?: string;
    timestamp?: string;
    relationship_context?: string;
    sentiment?: string;
    connection_context?: string;
  }>
) {
  try {
    // Step 1: Batch upsert person metadata
    // Deduplicate persons by lowercased name (last-writer-wins on metadata)
    const personMap = new Map<string, typeof persons[number]>();
    for (const p of persons) {
      if (p.name) personMap.set(p.name.trim().toLowerCase(), p);
    }
    const personItems: PersonBatchItem[] = Array.from(personMap.values())
      .map((p) => ({
        name: p.name!.trim(),
        newId: `p_${crypto.randomUUID().slice(0, 8)}`,
        company: p.company || null,
        email: p.email || null,
        category: p.category || null,
        title: p.title || null,
        relationship_to_me: p.relationship_to_me || null,
      }));

    for (const batch of chunk(personItems, CHUNK_SIZE)) {
      await batchUpsertPersons(userId, batch);
    }

    // Step 2: Collect all unique participant names across interactions
    const allParticipantNames = new Set<string>();
    for (const ix of interactions) {
      if (!Array.isArray(ix.participants)) continue;
      for (const name of ix.participants) {
        if (name && typeof name === "string") {
          allParticipantNames.add(name.trim());
        }
      }
    }

    // Step 3: Batch resolve all participants (create if missing, exclude "self")
    const resolveItems = Array.from(allParticipantNames).map((name) => ({
      name,
      newId: `p_${crypto.randomUUID().slice(0, 8)}`,
    }));

    const nameToId = new Map<string, string>();
    for (const batch of chunk(resolveItems, CHUNK_SIZE)) {
      const resolved = await batchResolveParticipants(userId, batch);
      for (const r of resolved) {
        nameToId.set(r.name.toLowerCase(), r.id);
      }
    }

    // Step 4: Batch create INTERACTED edges + score bumps
    const interactionItems: InteractionBatchItem[] = [];
    // Collect KNOWS edges per interaction (multi-participant)
    const knowsItems: KnowsBatchItem[] = [];

    for (const ix of interactions) {
      if (!Array.isArray(ix.participants) || ix.participants.length === 0) continue;

      const resolvedIds: string[] = [];

      for (const name of ix.participants) {
        if (!name || typeof name !== "string") continue;
        const personId = nameToId.get(name.trim().toLowerCase());
        if (!personId) continue;

        resolvedIds.push(personId);

        interactionItems.push({
          selfNodeId,
          personId,
          channel: ix.channel || "unknown",
          timestamp: ix.timestamp || new Date().toISOString(),
          summary: ix.summary || null,
          topic: ix.topic || null,
          relationshipContext: ix.relationship_context || null,
          sentiment: ix.sentiment || null,
        });
      }

      // KNOWS edges between participants in the same interaction
      if (resolvedIds.length >= 2) {
        for (let i = 0; i < resolvedIds.length; i++) {
          for (let j = i + 1; j < resolvedIds.length; j++) {
            knowsItems.push({
              idA: resolvedIds[i],
              idB: resolvedIds[j],
              channel: ix.channel || "co-presence",
              context: ix.connection_context || ix.summary || null,
            });
          }
        }
      }
    }

    for (const batch of chunk(interactionItems, CHUNK_SIZE)) {
      await batchCreateInteractions(userId, batch);
    }

    // Step 5: Batch MERGE KNOWS edges
    for (const batch of chunk(knowsItems, CHUNK_SIZE)) {
      await batchMergeKnows(userId, batch);
    }

    console.log(`[ingest] done for ${userId}: ${personItems.length} persons, ${interactionItems.length} interactions, ${knowsItems.length} knows edges`);
  } catch (err) {
    console.error("[ingest] background processing failed:", err);
  }
}
