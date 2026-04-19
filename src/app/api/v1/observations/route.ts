import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAgentOrSessionAuth } from "@/lib/api-auth";
import {
  observationsBatchSchema,
  MAX_BATCH,
} from "@/lib/observations-schema";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/v1/observations
 *
 * Append-only insert into the observation basket. Idempotent via a
 * DB-computed `dedup_key` (SHA-256 over kind + evidence_pointer + a
 * correction-specific tail). Re-posting the same observation is a
 * no-op at Postgres level. Max 100 rows per batch.
 *
 * Body: Observation[] (see src/lib/observations-schema.ts)
 * Response: { ok: true, accepted, inserted, deduped }
 */
export async function POST(request: Request) {
  const auth = await getAgentOrSessionAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = observationsBatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid batch",
        details: parsed.error.issues.slice(0, 10),
        max_batch: MAX_BATCH,
      },
      { status: 400 }
    );
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim(),
  );

  const { data, error } = await supabase.rpc("upsert_observations", {
    p_user_id: auth.userId,
    p_rows: parsed.data,
  });
  if (error) {
    console.error("[observations] rpc error", error);
    return NextResponse.json({ error: "write failed" }, { status: 502 });
  }

  const counts = Array.isArray(data) && data[0]
    ? data[0]
    : { inserted: 0, deduped: 0 };
  return NextResponse.json({
    ok: true,
    accepted: parsed.data.length,
    inserted: counts.inserted,
    deduped: counts.deduped,
  });
}
