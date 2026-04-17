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
import { normalizeCategory } from "@/lib/categories";
import { filterIngestPayload } from "@/lib/ingest-filters";
import { buildSelfIdentity } from "@/lib/self-identity";

// A participant can be either the legacy "just a name" string or the
// structured shape with email/phone. Connectors that know an identifier
// should always use the structured shape so matching can skip fuzzy name
// work and land deterministically on the canonical Person.
type ParticipantInput = string | { name: string; email?: string; phone?: string };

function participantName(p: ParticipantInput): string | null {
  if (typeof p === "string") return p.trim() || null;
  if (p && typeof p === "object" && typeof p.name === "string") {
    return p.name.trim() || null;
  }
  return null;
}

function participantEmail(p: ParticipantInput): string | null {
  if (typeof p === "string") return null;
  return (p && typeof p.email === "string" && p.email.trim()) || null;
}

function participantPhone(p: ParticipantInput): string | null {
  if (typeof p === "string") return null;
  return (p && typeof p.phone === "string" && p.phone.trim()) || null;
}

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

  // Filter the payload through the same filters processIngest uses, so the
  // counts we report match what will actually land in Neo4j.
  const { interactions: cleanInteractions, persons: cleanPersons } =
    filterIngestPayload(interactions, persons);

  const validInteractions = cleanInteractions.filter(
    (ix) => Array.isArray(ix.participants) && ix.participants.length > 0
  );

  // INTERACTED edges: one per (selfNode, participant) pair per interaction
  let expectedInteractedEdges = 0;
  // KNOWS edges: C(n,2) = n*(n-1)/2 per interaction where n = participant count >= 2
  let expectedKnowsEdges = 0;
  for (const ix of validInteractions) {
    const n = ix.participants!.length;
    expectedInteractedEdges += n;
    if (n >= 2) expectedKnowsEdges += (n * (n - 1)) / 2;
  }

  const accepted = {
    persons: cleanPersons.filter((p) => p.name).length,
    interactions: validInteractions.length,
  };

  const promise = processIngest(userId, selfNodeId, persons, interactions, {
    authEmail: auth.authEmail,
    displayName: auth.displayName,
  });

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
    // Reflects what processIngest will create (after dedup on the Neo4j side).
    // These are upper bounds — actual writes may be slightly lower if names
    // dedupe or MERGE hits an existing edge.
    stats: {
      personsCreated: accepted.persons,
      personsUpdated: 0,
      interactionsCreated: expectedInteractedEdges,
      edgesCreated: expectedKnowsEdges,
    },
  });
}

async function processIngest(
  userId: string,
  selfNodeId: string,
  persons: Array<{
    name?: string;
    company?: string;
    email?: string;
    phone?: string;
    category?: string;
    title?: string;
    relationship_to_me?: string;
  }>,
  interactions: Array<{
    participants?: ParticipantInput[];
    channel?: string;
    summary?: string;
    topic?: string;
    timestamp?: string;
    relationship_context?: string;
    sentiment?: string;
    connection_context?: string;
  }>,
  authExtras: { authEmail?: string; displayName?: string }
) {
  try {
    // Step 0: Filter junk (bots, newsletters, phone-number names) + normalize categories
    const { interactions: cleanInteractions, persons: cleanPersons, filtered } = filterIngestPayload(interactions, persons);
    if (filtered.bots + filtered.junkParticipants + filtered.newsletters > 0) {
      console.log(`[ingest] filtered: ${JSON.stringify(filtered)}`);
    }

    // Step 0.5: build the self-identity signature so batchResolveParticipants
    // can route any self-reference onto the canonical self node.
    const selfIdentity = await buildSelfIdentity(userId, selfNodeId, authExtras);

    // Step 1: Batch upsert person metadata
    // Deduplicate persons by lowercased name (last-writer-wins on metadata)
    const personMap = new Map<string, typeof cleanPersons[number]>();
    for (const p of cleanPersons) {
      if (p.name) personMap.set(p.name.trim().toLowerCase(), p);
    }
    const personItems: PersonBatchItem[] = Array.from(personMap.values())
      .map((p) => ({
        name: p.name!.trim(),
        newId: `p_${crypto.randomUUID().slice(0, 8)}`,
        company: p.company || null,
        email: p.email || null,
        phone: p.phone || null,
        category: normalizeCategory(p.category),
        title: p.title || null,
        relationship_to_me: p.relationship_to_me || null,
      }));

    for (const batch of chunk(personItems, CHUNK_SIZE)) {
      await batchUpsertPersons(userId, batch);
    }

    // Step 2: Collect unique participants keyed by strongest identifier,
    // so that multiple signals for the same person (even with slightly
    // different name spellings) collapse to a single resolve item.
    // Identity-key priority: email > phone > lowercased name.
    type Participant = { name: string; email: string | null; phone: string | null };
    const byIdent = new Map<string, Participant>();
    // Parallel map from each raw lowercased name → ident key, so Step 4
    // can look up the resolved id regardless of how the participant was
    // first collapsed.
    const nameToIdent = new Map<string, string>();

    const normPhone = (s: string | null): string | null => {
      if (!s) return null;
      const d = s.replace(/\D/g, "");
      return d.length >= 7 ? d : null;
    };

    const identKey = (p: Participant): string => {
      if (p.email) return `e:${p.email.toLowerCase()}`;
      if (p.phone) return `p:${p.phone}`;
      return `n:${p.name.toLowerCase()}`;
    };

    for (const ix of cleanInteractions) {
      if (!Array.isArray(ix.participants)) continue;
      for (const raw of ix.participants) {
        const name = participantName(raw);
        if (!name) continue;
        const email = participantEmail(raw)?.toLowerCase() || null;
        const phone = normPhone(participantPhone(raw));

        const candidate: Participant = { name, email, phone };
        const key = identKey(candidate);

        const existing = byIdent.get(key);
        if (!existing) {
          byIdent.set(key, candidate);
        } else {
          // Longer name is usually more informative. Union identifiers.
          if (name.length > existing.name.length) existing.name = name;
          if (!existing.email && email) existing.email = email;
          if (!existing.phone && phone) existing.phone = phone;
        }
        // Track every lowercased name we saw → key, so Step 4 can lookup.
        nameToIdent.set(name.toLowerCase(), key);
      }
    }

    // Step 3: Batch resolve all participants (create if missing, route self)
    const resolveItems = Array.from(byIdent.entries()).map(([key, p]) => ({
      key,
      name: p.name,
      email: p.email,
      phone: p.phone,
      newId: `p_${crypto.randomUUID().slice(0, 8)}`,
    }));

    const keyToId = new Map<string, string>();
    for (const batch of chunk(resolveItems, CHUNK_SIZE)) {
      // batchResolveParticipants returns {id, name} keyed by input name order;
      // we match back via the order of items in the batch.
      const resolved = await batchResolveParticipants(userId, selfIdentity, batch);
      for (let i = 0; i < batch.length; i++) {
        keyToId.set(batch[i].key, resolved[i].id);
      }
    }

    // Step 4: Batch create INTERACTED edges + score bumps
    const interactionItems: InteractionBatchItem[] = [];
    // Collect KNOWS edges per interaction (multi-participant)
    const knowsItems: KnowsBatchItem[] = [];

    for (const ix of cleanInteractions) {
      if (!Array.isArray(ix.participants) || ix.participants.length === 0) continue;

      const resolvedIds: string[] = [];

      for (const raw of ix.participants) {
        const name = participantName(raw);
        if (!name) continue;
        const email = participantEmail(raw)?.toLowerCase() || null;
        const phone = normPhone(participantPhone(raw));
        const candidate: Participant = { name, email, phone };
        let personId = keyToId.get(identKey(candidate));
        // Fallback: if this exact ident key wasn't collapsed (e.g. email
        // showed up on one signal but not another), look up via any name
        // we saw during collection.
        if (!personId) {
          const k = nameToIdent.get(name.toLowerCase());
          if (k) personId = keyToId.get(k);
        }
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
