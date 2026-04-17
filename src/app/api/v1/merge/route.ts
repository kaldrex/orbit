import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getDriver } from "@/lib/neo4j";
import { getAgentOrSessionAuth } from "@/lib/api-auth";
import neo4j from "neo4j-driver";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/v1/merge
 *
 * Merge duplicate Person nodes. The canonical node keeps its identity; the
 * merge_ids' INTERACTED and KNOWS edges are re-pointed to canonical, their
 * null metadata is filled in from the merged sources, and they are
 * DETACH DELETEd. The merge is recorded in Supabase merge_audit for later
 * revocation (Phase 9.5 user corrections).
 *
 * Body:
 * {
 *   canonical_id: "p_0e0113c6",
 *   merge_ids: ["p_6ea6e11d", "p_5ed7b846"],
 *   reasoning: "All three are Ramon Berrios — shared email + name variants",
 *   confidence: 0.95,                           // 0..1
 *   source: "auto" | "llm" | "user",
 *   evidence?: { ... }                          // freeform context (for audit)
 * }
 *
 * Idempotent: if all merge_ids already resolve to canonical (already merged),
 * returns ok without re-writing.
 */
interface MergeRequest {
  canonical_id: string;
  merge_ids: string[];
  reasoning?: string;
  confidence?: number;
  source: "auto" | "llm" | "user";
  evidence?: Record<string, unknown>;
}

export async function POST(request: NextRequest) {
  const auth = await getAgentOrSessionAuth(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json()) as MergeRequest;

  if (!body.canonical_id || typeof body.canonical_id !== "string") {
    return NextResponse.json({ error: "canonical_id required" }, { status: 400 });
  }
  if (!Array.isArray(body.merge_ids) || body.merge_ids.length === 0) {
    return NextResponse.json({ error: "merge_ids must be a non-empty array" }, { status: 400 });
  }
  if (!["auto", "llm", "user"].includes(body.source)) {
    return NextResponse.json({ error: "source must be auto | llm | user" }, { status: 400 });
  }
  if (body.merge_ids.includes(body.canonical_id)) {
    return NextResponse.json({ error: "canonical_id cannot appear in merge_ids" }, { status: 400 });
  }
  if (body.confidence != null && (body.confidence < 0 || body.confidence > 1)) {
    return NextResponse.json({ error: "confidence must be 0..1" }, { status: 400 });
  }

  const { userId } = auth;
  const dbName = (process.env.NEO4J_DATABASE || "neo4j").trim();
  const session = getDriver().session({ database: dbName, defaultAccessMode: neo4j.session.WRITE });

  try {
    // Verify all ids belong to the tenant AND none is the self node.
    const check = await session.run(
      `MATCH (p:Person {userId: $userId})
       WHERE p.id IN $all
       RETURN p.id AS id, p.category AS category, p.name AS name`,
      { userId, all: [body.canonical_id, ...body.merge_ids] }
    );
    const found = new Map<string, { category: string; name: string }>();
    for (const r of check.records) {
      found.set(r.get("id") as string, {
        category: r.get("category") as string,
        name: r.get("name") as string,
      });
    }
    const missing = [body.canonical_id, ...body.merge_ids].filter((id) => !found.has(id));
    if (missing.length > 0) {
      // If only the merge_ids are missing, treat as a no-op (already merged).
      const onlyMergeMissing = missing.every((id) => id !== body.canonical_id);
      if (onlyMergeMissing && found.has(body.canonical_id)) {
        return NextResponse.json({ ok: true, status: "already-merged", missing });
      }
      return NextResponse.json(
        { error: "some ids not found in this tenant", missing },
        { status: 404 }
      );
    }
    const canonicalMeta = found.get(body.canonical_id)!;
    if (canonicalMeta.category === "self") {
      // Merging INTO self is valid (it's how Phase 2 self-dedup worked via a
      // one-shot migration). Allow it but force source to user|auto — never LLM.
      if (body.source === "llm") {
        return NextResponse.json(
          { error: "LLM-proposed merges into the self node are blocked for safety" },
          { status: 400 }
        );
      }
    }
    // Reject merging the self node as one of the merge_ids — self should
    // always be the canonical identity.
    for (const mid of body.merge_ids) {
      if (found.get(mid)?.category === "self") {
        return NextResponse.json(
          { error: `refusing to merge the self node (${mid}) into another Person` },
          { status: 400 }
        );
      }
    }

    // Apply the merge in a single transaction.
    const tx = session.beginTransaction();
    let counters = { interactedRepointed: 0, knowsRepointed: 0, deleted: 0 };
    try {
      // 1. Re-point INTERACTED edges where the merge_ids are the TARGET (b).
      //    Dedup: if self→canonical already has an edge with same channel+timestamp,
      //    skip the new one. Otherwise create with the merge_id's properties.
      const ixRes = await tx.run(
        `MATCH (a:Person {userId: $userId})-[r:INTERACTED]->(m:Person {userId: $userId})
         WHERE m.id IN $mergeIds
         MATCH (canonical:Person {id: $canonicalId, userId: $userId})
         WHERE NOT EXISTS {
           MATCH (a)-[r2:INTERACTED]->(canonical)
           WHERE r2.channel = r.channel AND r2.timestamp = r.timestamp
         }
         CREATE (a)-[new:INTERACTED {
           channel: r.channel,
           timestamp: r.timestamp,
           summary: r.summary,
           topic_summary: r.topic_summary,
           relationship_context: r.relationship_context,
           sentiment: r.sentiment
         }]->(canonical)
         RETURN count(new) AS n`,
        { userId, mergeIds: body.merge_ids, canonicalId: body.canonical_id }
      );
      counters.interactedRepointed = ixRes.records[0].get("n").toNumber();

      // 2. Re-point KNOWS edges involving merge_ids → canonical.
      //    Drop self-loops that would result (canonical KNOWS canonical).
      const knowsRes = await tx.run(
        `MATCH (m:Person {userId: $userId})-[k:KNOWS]->(other:Person {userId: $userId})
         WHERE m.id IN $mergeIds AND other.id <> $canonicalId AND NOT other.id IN $mergeIds
         MATCH (canonical:Person {id: $canonicalId, userId: $userId})
         MERGE (canonical)-[new:KNOWS]->(other)
         ON CREATE SET new.source = k.source, new.context = k.context, new.created_at = datetime()
         ON MATCH SET new.context = CASE
           WHEN k.context IS NOT NULL AND new.context IS NOT NULL AND NOT new.context CONTAINS k.context
             THEN new.context + " | " + k.context
           WHEN k.context IS NOT NULL AND new.context IS NULL THEN k.context
           ELSE new.context
         END
         RETURN count(new) AS n`,
        { userId, mergeIds: body.merge_ids, canonicalId: body.canonical_id }
      );
      counters.knowsRepointed += knowsRes.records[0].get("n").toNumber();

      const knowsIncRes = await tx.run(
        `MATCH (other:Person {userId: $userId})-[k:KNOWS]->(m:Person {userId: $userId})
         WHERE m.id IN $mergeIds AND other.id <> $canonicalId AND NOT other.id IN $mergeIds
         MATCH (canonical:Person {id: $canonicalId, userId: $userId})
         MERGE (other)-[new:KNOWS]->(canonical)
         ON CREATE SET new.source = k.source, new.context = k.context, new.created_at = datetime()
         ON MATCH SET new.context = CASE
           WHEN k.context IS NOT NULL AND new.context IS NOT NULL AND NOT new.context CONTAINS k.context
             THEN new.context + " | " + k.context
           WHEN k.context IS NOT NULL AND new.context IS NULL THEN k.context
           ELSE new.context
         END
         RETURN count(new) AS n`,
        { userId, mergeIds: body.merge_ids, canonicalId: body.canonical_id }
      );
      counters.knowsRepointed += knowsIncRes.records[0].get("n").toNumber();

      // 3. Union metadata onto canonical: emails, phones, company, title,
      //    relationship_to_me, category, relationship_score. Canonical wins
      //    when it already has a value; merged nodes fill in nulls.
      await tx.run(
        `MATCH (canonical:Person {id: $canonicalId, userId: $userId})
         MATCH (m:Person {userId: $userId}) WHERE m.id IN $mergeIds
         WITH canonical, collect(m) AS merged
         WITH canonical,
              [x IN merged WHERE x.email IS NOT NULL | x.email] AS emails,
              [x IN merged WHERE x.phone IS NOT NULL | x.phone] AS phones,
              [x IN merged WHERE x.company IS NOT NULL | x.company] AS companies,
              [x IN merged WHERE x.title IS NOT NULL | x.title] AS titles,
              [x IN merged WHERE x.relationship_to_me IS NOT NULL | x.relationship_to_me] AS rels,
              [x IN merged WHERE x.category IS NOT NULL AND x.category <> "other" | x.category] AS cats,
              [x IN merged | x.relationship_score] AS scores,
              [x IN merged WHERE x.name IS NOT NULL | x.name] AS altNames
         SET canonical.email = COALESCE(canonical.email, head(emails)),
             canonical.phone = COALESCE(canonical.phone, head(phones)),
             canonical.company = COALESCE(canonical.company, head(companies)),
             canonical.title = COALESCE(canonical.title, head(titles)),
             canonical.relationship_to_me = COALESCE(canonical.relationship_to_me, head(rels)),
             canonical.category = CASE
               WHEN canonical.category = "other" AND size(cats) > 0 THEN head(cats)
               ELSE canonical.category
             END,
             canonical.relationship_score = CASE
               WHEN canonical.relationship_score IS NULL THEN reduce(m = 0.0, v IN scores | CASE WHEN v > m THEN v ELSE m END)
               ELSE reduce(m = canonical.relationship_score, v IN scores | CASE WHEN v > m THEN v ELSE m END)
             END,
             canonical.aliases = CASE
               WHEN canonical.aliases IS NULL THEN [x IN altNames WHERE toLower(x) <> toLower(canonical.name)]
               ELSE canonical.aliases + [x IN altNames WHERE toLower(x) <> toLower(canonical.name) AND NOT x IN canonical.aliases]
             END`,
        { userId, mergeIds: body.merge_ids, canonicalId: body.canonical_id }
      );

      // 4. DETACH DELETE merged nodes
      const delRes = await tx.run(
        `MATCH (m:Person {userId: $userId}) WHERE m.id IN $mergeIds
         DETACH DELETE m
         RETURN count(m) AS n`,
        { userId, mergeIds: body.merge_ids }
      );
      counters.deleted = delRes.records[0].get("n").toNumber();

      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }

    // 5. Audit log in Supabase.
    try {
      const serviceUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
      const serviceKey =
        process.env.SUPABASE_SERVICE_ROLE_KEY ||
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
      const supabase = createClient(serviceUrl, serviceKey);
      await supabase.from("merge_audit").insert({
        user_id: userId,
        canonical_id: body.canonical_id,
        merged_ids: body.merge_ids,
        reasoning: body.reasoning ?? null,
        confidence: body.confidence ?? null,
        source: body.source,
        evidence: body.evidence ?? null,
      });
    } catch (err) {
      // Audit failure should not roll back the merge — log and continue.
      console.warn("[merge] audit write failed:", err);
    }

    return NextResponse.json({
      ok: true,
      canonical_id: body.canonical_id,
      merged: counters.deleted,
      counters,
    });
  } finally {
    await session.close();
  }
}
