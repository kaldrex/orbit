import neo4j, { Driver } from "neo4j-driver";
import {
  RESOLVE_PARTICIPANTS_CYPHER,
  normalizeEmail,
  normalizePhone,
} from "@/lib/cypher/resolve-participants";
import type { SelfIdentity } from "@/lib/self-identity";

let driver: Driver | null = null;

export function getDriver(): Driver {
  if (!driver) {
    const uri = (process.env.NEO4J_URI || "").trim();
    const user = (process.env.NEO4J_USER || "").trim();
    const password = (process.env.NEO4J_PASSWORD || "").trim();

    // Diagnostic: log env var lengths to catch trailing newlines
    console.log(`[neo4j] creating driver: uri=${uri.length}chars, user=${user.length}chars, pass=${password.length}chars`);

    driver = neo4j.driver(
      uri,
      neo4j.auth.basic(user, password),
      { maxConnectionPoolSize: 50 }
    );
  }
  return driver;
}

/**
 * Recursively unwrap Neo4j driver types to plain JS values.
 * Handles: Integer → number, Node → properties object, Relationship → properties.
 */
function unwrapValue(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (neo4j.isInt(val)) return (val as { toNumber(): number }).toNumber();
  // Node object — has .properties
  if (typeof val === "object" && val !== null && "properties" in val && "labels" in val) {
    const props = (val as { properties: Record<string, unknown> }).properties;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      out[k] = unwrapValue(v);
    }
    return out;
  }
  // Relationship object
  if (typeof val === "object" && val !== null && "properties" in val && "type" in val) {
    const props = (val as { properties: Record<string, unknown> }).properties;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      out[k] = unwrapValue(v);
    }
    return out;
  }
  if (Array.isArray(val)) return val.map(unwrapValue);
  return val;
}

/**
 * Tenant-isolated Neo4j query helper.
 * Every query receives a `userId` param for multi-tenant isolation.
 * Callers MUST include `WHERE ... userId = $userId` in their Cypher.
 */
export async function queryNeo4j<T = Record<string, unknown>>(
  userId: string,
  cypher: string,
  params: Record<string, unknown> = {}
): Promise<T[]> {
  const session = getDriver().session({
    database: (process.env.NEO4J_DATABASE || "neo4j").trim(),
  });
  try {
    const result = await session.run(cypher, { ...params, userId });
    return result.records.map((r) => {
      const obj: Record<string, unknown> = {};
      for (const key of r.keys) {
        obj[key as string] = unwrapValue(r.get(key));
      }
      return obj as T;
    });
  } finally {
    await session.close();
  }
}

/**
 * Write query helper — same as queryNeo4j but uses WRITE access mode.
 */
export async function writeNeo4j(
  userId: string,
  cypher: string,
  params: Record<string, unknown> = {}
): Promise<void> {
  const session = getDriver().session({
    database: (process.env.NEO4J_DATABASE || "neo4j").trim(),
    defaultAccessMode: neo4j.session.WRITE,
  });
  try {
    await session.run(cypher, { ...params, userId });
  } finally {
    await session.close();
  }
}

// --------------- Batch helpers for ingest ---------------

export interface PersonBatchItem {
  name: string;
  newId: string;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  category?: string | null;
  title?: string | null;
  relationship_to_me?: string | null;
}

/**
 * Batch upsert persons via UNWIND. Case-insensitive MERGE by name + userId.
 * Returns the resolved id and name for each item in the batch.
 */
export async function batchUpsertPersons(
  userId: string,
  batch: PersonBatchItem[]
): Promise<{ id: string; name: string }[]> {
  if (batch.length === 0) return [];

  const session = getDriver().session({
    database: (process.env.NEO4J_DATABASE || "neo4j").trim(),
    defaultAccessMode: neo4j.session.WRITE,
  });
  try {
    const result = await session.run(
      `UNWIND $batch AS p
       OPTIONAL MATCH (existing:Person {userId: $userId})
         WHERE toLower(existing.name) = toLower(p.name)
       SET existing.company = CASE WHEN p.company IS NOT NULL THEN p.company ELSE existing.company END,
           existing.email = CASE WHEN p.email IS NOT NULL THEN p.email ELSE existing.email END,
           existing.phone = CASE WHEN p.phone IS NOT NULL THEN p.phone ELSE existing.phone END,
           existing.category = CASE WHEN p.category IS NOT NULL THEN p.category ELSE existing.category END,
           existing.title = CASE WHEN p.title IS NOT NULL THEN p.title ELSE existing.title END,
           existing.relationship_to_me = CASE WHEN p.relationship_to_me IS NOT NULL THEN p.relationship_to_me ELSE existing.relationship_to_me END
       FOREACH (_ IN CASE WHEN existing IS NULL THEN [1] ELSE [] END |
         CREATE (:Person {
           id: p.newId, userId: $userId, name: p.name,
           company: p.company, email: p.email, phone: p.phone,
           category: COALESCE(p.category, "other"),
           title: p.title,
           relationship_to_me: p.relationship_to_me,
           relationship_score: 1, source: "agent"
         })
       )
       RETURN COALESCE(existing.id, p.newId) AS id, p.name AS name`,
      { userId, batch }
    );
    return result.records.map((r) => ({
      id: r.get("id") as string,
      name: r.get("name") as string,
    }));
  } finally {
    await session.close();
  }
}

export interface InteractionBatchItem {
  selfNodeId: string;
  personId: string;
  channel: string;
  timestamp: string;
  summary: string | null;
  topic: string | null;
  relationshipContext: string | null;
  sentiment: string | null;
  // Source-level provenance (additive, additive, nullable — older rows lack these).
  // Required to stop the ~40% field drop at ingest identified in the 2026-04-18
  // hypothesis audit, and to make events replayable from raw_events later.
  source: string | null;           // "whatsapp" | "gmail" | "calendar" | "slack" | "linear"
  sourceEventId: string | null;    // Gmail message_id, WA msg_id, Calendar event id
  threadId: string | null;         // Gmail thread_id, WA chat_jid, Slack thread_ts
  bodyPreview: string | null;      // first ~160 chars of body; null for pure metadata events
  direction: string | null;        // "in" | "out" (from self's perspective)
}

/**
 * Batch create INTERACTED edges + bump relationship scores via UNWIND.
 */
export async function batchCreateInteractions(
  userId: string,
  batch: InteractionBatchItem[]
): Promise<void> {
  if (batch.length === 0) return;

  const session = getDriver().session({
    database: (process.env.NEO4J_DATABASE || "neo4j").trim(),
    defaultAccessMode: neo4j.session.WRITE,
  });
  try {
    await session.run(
      `UNWIND $batch AS ix
       MATCH (a:Person {id: ix.selfNodeId, userId: $userId}),
             (b:Person {id: ix.personId, userId: $userId})
       CREATE (a)-[:INTERACTED {
         channel: ix.channel,
         timestamp: ix.timestamp,
         summary: ix.summary,
         topic_summary: ix.topic,
         relationship_context: ix.relationshipContext,
         sentiment: ix.sentiment,
         source: ix.source,
         source_event_id: ix.sourceEventId,
         thread_id: ix.threadId,
         body_preview: ix.bodyPreview,
         direction: ix.direction
       }]->(b)
       SET b.last_interaction_at = datetime().epochMillis,
           b.relationship_score = CASE
             WHEN b.relationship_score < 10
             THEN b.relationship_score + 0.1
             ELSE b.relationship_score
           END`,
      { userId, batch }
    );
  } finally {
    await session.close();
  }
}

export interface KnowsBatchItem {
  idA: string;
  idB: string;
  channel: string;
  context: string | null;
}

/**
 * Batch MERGE KNOWS edges between participants via UNWIND.
 */
export async function batchMergeKnows(
  userId: string,
  batch: KnowsBatchItem[]
): Promise<void> {
  if (batch.length === 0) return;

  const session = getDriver().session({
    database: (process.env.NEO4J_DATABASE || "neo4j").trim(),
    defaultAccessMode: neo4j.session.WRITE,
  });
  try {
    await session.run(
      `UNWIND $batch AS k
       MATCH (a:Person {id: k.idA, userId: $userId}),
             (b:Person {id: k.idB, userId: $userId})
       MERGE (a)-[r:KNOWS]->(b)
       ON CREATE SET r.source = k.channel, r.context = k.context, r.created_at = datetime()
       ON MATCH SET r.context = CASE
         WHEN k.context IS NOT NULL AND r.context IS NOT NULL THEN r.context + " | " + k.context
         WHEN k.context IS NOT NULL THEN k.context
         ELSE r.context
       END`,
      { userId, batch }
    );
  } finally {
    await session.close();
  }
}

export interface ResolveParticipantItem {
  name: string;
  newId: string;
  email?: string | null;
  phone?: string | null;
}

/**
 * Resolve interaction participants with a 4-tier match cascade:
 *
 *   1. email match  — if input carries email, pick Person with same email
 *   2. phone match  — if input carries phone (digits-only), match
 *   3. self match   — if input's email/phone/name hits a known self-alias,
 *                     route to the user's canonical self node
 *   4. name match   — case-insensitive, excluding category="self"
 *   5. create new   — with email/phone attached so next tick matches
 *
 * Also opportunistically fills email/phone on matched Persons that lacked them,
 * so future matching tightens over time without a separate backfill.
 *
 * The Cypher is shared with scripts/replay-bleed.js via
 * src/lib/cypher/resolve-participants.js so the bleed-rate replay always
 * exercises the exact same query the server runs.
 */
export async function batchResolveParticipants(
  userId: string,
  selfIdentity: SelfIdentity,
  batch: ResolveParticipantItem[]
): Promise<{ id: string; name: string }[]> {
  if (batch.length === 0) return [];

  // Normalize the batch so the Cypher doesn't have to care about shape.
  const normalized = batch.map((b) => ({
    name: b.name,
    newId: b.newId,
    email: normalizeEmail(b.email ?? null),
    phone: normalizePhone(b.phone ?? null),
  }));

  const session = getDriver().session({
    database: (process.env.NEO4J_DATABASE || "neo4j").trim(),
    defaultAccessMode: neo4j.session.WRITE,
  });
  try {
    const result = await session.run(RESOLVE_PARTICIPANTS_CYPHER, {
      userId,
      batch: normalized,
      selfEmails: selfIdentity.emails,
      selfPhones: selfIdentity.phones,
      selfNames: selfIdentity.names,
    });
    return result.records.map((r) => ({
      id: r.get("id") as string,
      name: r.get("name") as string,
    }));
  } finally {
    await session.close();
  }
}
