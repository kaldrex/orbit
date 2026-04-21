import { NextResponse } from "next/server";
import { getAgentOrSessionAuth } from "@/lib/api-auth";
import { withReadSession } from "@/lib/neo4j";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface GoingColdPerson {
  id: string;
  name: string | null;
  category: string | null;
  last_touch: string | null;
  days_since: number;
  score: number;
}

const COLD_THRESHOLD_DAYS = 14;
// Threshold matches `GOING_COLD_MIN_SCORE` in src/lib/graph-transforms.ts.
// Tuned against Sanchay's populate output: max ~10 (self) / 1.4-2.8 (real
// human hubs with ≥ 2 interaction edges). `>2` surfaces two-edge-plus
// relationships that have gone quiet without flooding the list with
// single-DM long-tail contacts.
const MIN_SCORE = 2;

/**
 * GET /api/v1/persons/going-cold
 *
 * Returns persons the founder has gone cold on: score > 5 AND
 * last_interaction_at older than 14 days. Sorted oldest-first.
 *
 * Response: { persons: GoingColdPerson[], total: number }
 *
 * Graceful degradation: if Neo4j is empty OR unreachable, returns HTTP 200
 * with an empty persons array and warning log. Matches the posture of
 * `GET /api/v1/graph` — dashboard never breaks on a cold DB.
 */
export async function GET(request: Request) {
  const auth = await getAgentOrSessionAuth(request);
  if (!auth) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 },
    );
  }

  try {
    const persons = await withReadSession(async (session) => {
      // last_interaction_at is stored as an ISO-8601 string (Postgres
      // timestamptz serialised by the JS driver before write); cast to
      // datetime() so the comparison is temporal rather than lexical.
      const result = await session.run(
        `MATCH (p:Person {user_id: $uid})
         WHERE p.last_interaction_at IS NOT NULL
           AND datetime(p.last_interaction_at) < datetime() - duration('P14D')
           AND p.score > $min_score
         RETURN p.id AS id,
                p.name AS name,
                p.category AS category,
                p.last_interaction_at AS last_touch,
                p.score AS score
         ORDER BY datetime(p.last_interaction_at) ASC`,
        { uid: auth.userId, min_score: MIN_SCORE },
      );

      const now = Date.now();
      return result.records.map((r): GoingColdPerson => {
        const lastRaw = r.get("last_touch");
        const last_touch = lastRaw == null ? null : String(lastRaw);
        let days_since = 0;
        if (last_touch) {
          const t = Date.parse(last_touch);
          if (Number.isFinite(t)) {
            days_since = Math.max(0, Math.floor((now - t) / (1000 * 60 * 60 * 24)));
          }
        }
        return {
          id: String(r.get("id")),
          name: (r.get("name") as string | null) ?? null,
          category: (r.get("category") as string | null) ?? null,
          last_touch,
          days_since,
          score: Number(r.get("score") ?? 0),
        };
      });
    });

    return NextResponse.json({ persons, total: persons.length });
  } catch (err) {
    console.warn(
      "[api/v1/persons/going-cold] Neo4j read failed; returning empty list",
      err,
    );
    return NextResponse.json({ persons: [], total: 0 });
  }
}
