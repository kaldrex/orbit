// Neo4j write helpers for the populate route.
//
// Split out so the route stays readable: this module owns (a) the edge
// weight formula from agent-docs/18-neo4j-edge-model-proposal.md, and
// (b) the raw Cypher phases. See the populate route for orchestration.
//
// All writes are idempotent via MERGE. Re-running populate yields the
// same graph state. Prune removes nodes/edges whose `updated_at` is
// older than the current run, so deletions in Postgres propagate.

import type { Session } from "neo4j-driver";

/** Days-since-last / 180 day half-life, clamped >= 0. */
export function recencyFactor(daysSinceLast: number): number {
  if (!Number.isFinite(daysSinceLast) || daysSinceLast < 0) daysSinceLast = 0;
  return Math.exp(-daysSinceLast / 180);
}

/**
 * Edge weight for DM / EMAILED: log(1+count) * exp(-days_since_last/180).
 *
 * Matches the task brief's formula exactly. Doc 18 proposes a slight
 * variant (log10) -- we use natural log per the brief, which was
 * deliberate when it pinned "Time-decay weight" on this loop.
 */
export function computeWeight(count: number, lastAtISO: string | null, now: Date = new Date()): number {
  if (!count || count <= 0) return 0;
  const safeCount = Math.max(1, count);
  let days = 0;
  if (lastAtISO) {
    const t = Date.parse(lastAtISO);
    if (Number.isFinite(t)) {
      days = Math.max(0, (now.getTime() - t) / (1000 * 60 * 60 * 24));
    }
  }
  return Math.log(1 + safeCount) * recencyFactor(days);
}

/**
 * SHARED_GROUP weight: count of shared groups, recency-weighted off the
 * most recent message across any shared group. Doc 18 says "no recency
 * term" for SHARED_GROUP, but the task brief explicitly ties ALL edge
 * types to the same `log(1 + count) * exp(-days/180)` loop -- we follow
 * the brief here (flagged as open question #3).
 */
export function computeSharedGroupWeight(groupCount: number, lastAtISO: string | null, now: Date = new Date()): number {
  return computeWeight(groupCount, lastAtISO, now);
}

export interface GraphNode {
  id: string;
  user_id: string;
  name: string | null;
  category: string | null;
  company: string | null;
  title: string | null;
  relationship_to_me: string;
  phone_count: number;
  email_count: number;
  first_seen: string | null;
  last_seen: string | null;
  updated_at: string;
}

export interface GraphEdge {
  a_id: string;
  b_id: string;
  user_id: string;
  weight: number;
  updated_at: string;
  // edge-type-specific:
  group_ids?: string[];
  group_count?: number;
  message_count?: number;
  thread_count?: number;
  first_at?: string | null;
  last_at?: string | null;
}

// ---------------------------------------------------------------------------
// Index bootstrap (cheap, CREATE IF NOT EXISTS semantics via IF NOT EXISTS).
// ---------------------------------------------------------------------------

const INDEX_CYPHER: string[] = [
  "CREATE INDEX person_id_user IF NOT EXISTS FOR (p:Person) ON (p.id, p.user_id)",
  "CREATE INDEX person_user_category IF NOT EXISTS FOR (p:Person) ON (p.user_id, p.category)",
  "CREATE INDEX person_user_last_seen IF NOT EXISTS FOR (p:Person) ON (p.user_id, p.last_seen)",
];

export async function ensureIndexes(session: Session): Promise<void> {
  for (const cypher of INDEX_CYPHER) {
    await session.run(cypher);
  }
}

// ---------------------------------------------------------------------------
// Node upsert -- one UNWIND per batch (default 500).
// ---------------------------------------------------------------------------

const NODE_BATCH = 500;

export async function mergeNodes(session: Session, nodes: GraphNode[]): Promise<number> {
  let written = 0;
  for (let i = 0; i < nodes.length; i += NODE_BATCH) {
    const slice = nodes.slice(i, i + NODE_BATCH);
    await session.run(
      `
      UNWIND $rows AS row
      MERGE (p:Person {id: row.id, user_id: row.user_id})
      SET p.name = row.name,
          p.category = row.category,
          p.company = row.company,
          p.title = row.title,
          p.relationship_to_me = row.relationship_to_me,
          p.phone_count = row.phone_count,
          p.email_count = row.email_count,
          p.first_seen = row.first_seen,
          p.last_seen = row.last_seen,
          p.updated_at = row.updated_at
      `,
      { rows: slice },
    );
    written += slice.length;
  }
  return written;
}

// ---------------------------------------------------------------------------
// Edge upsert -- parameterized on edge type so we can share the MERGE.
// Neo4j doesn't allow parameterizing the relationship type directly, so
// we switch on the input.
// ---------------------------------------------------------------------------

const EDGE_BATCH = 500;

export type EdgeType = "DM" | "SHARED_GROUP" | "EMAILED";

function edgeCypher(type: EdgeType): string {
  // The common SET block mirrors the properties each edge type carries
  // (see doc 18). Unused properties are simply not set -- Neo4j is
  // schemaless so absence is fine.
  return `
    UNWIND $rows AS e
    MATCH (a:Person {id: e.a_id, user_id: e.user_id})
    MATCH (b:Person {id: e.b_id, user_id: e.user_id})
    MERGE (a)-[r:${type}]-(b)
    SET r.user_id = e.user_id,
        r.weight = e.weight,
        r.updated_at = e.updated_at,
        r.message_count = COALESCE(e.message_count, r.message_count),
        r.thread_count = COALESCE(e.thread_count, r.thread_count),
        r.group_count = COALESCE(e.group_count, r.group_count),
        r.group_ids = COALESCE(e.group_ids, r.group_ids),
        r.first_at = COALESCE(e.first_at, r.first_at),
        r.last_at = COALESCE(e.last_at, r.last_at)
  `;
}

export async function mergeEdges(
  session: Session,
  type: EdgeType,
  edges: GraphEdge[],
): Promise<number> {
  let written = 0;
  const cypher = edgeCypher(type);
  for (let i = 0; i < edges.length; i += EDGE_BATCH) {
    const slice = edges.slice(i, i + EDGE_BATCH);
    await session.run(cypher, { rows: slice });
    written += slice.length;
  }
  return written;
}

// ---------------------------------------------------------------------------
// Prune: drop nodes/edges scoped to this user whose updated_at is stale.
// ---------------------------------------------------------------------------

export async function pruneStaleEdges(
  session: Session,
  userId: string,
  runAt: string,
): Promise<number> {
  const res = await session.run(
    `
    MATCH ()-[r]-()
    WHERE r.user_id = $user_id
      AND (type(r) = 'DM' OR type(r) = 'SHARED_GROUP' OR type(r) = 'EMAILED')
      AND r.updated_at < $run_at
    DELETE r
    RETURN count(r) AS n
    `,
    { user_id: userId, run_at: runAt },
  );
  const rec = res.records[0];
  return rec ? Number(rec.get("n")) : 0;
}

export async function pruneStaleNodes(
  session: Session,
  userId: string,
  runAt: string,
): Promise<number> {
  const res = await session.run(
    `
    MATCH (p:Person {user_id: $user_id})
    WHERE p.updated_at < $run_at
    DETACH DELETE p
    RETURN count(p) AS n
    `,
    { user_id: userId, run_at: runAt },
  );
  const rec = res.records[0];
  return rec ? Number(rec.get("n")) : 0;
}
