import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAgentOrSessionAuth } from "@/lib/api-auth";
import { rawEventsBatchSchema, MAX_BATCH } from "@/lib/raw-events-schema";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/v1/raw_events
 *
 * Idempotent bulk upsert into the immutable raw_events ledger.
 * Unique key (user_id, source, source_event_id) — re-sending the same
 * event is a no-op at Postgres level. Max 500 rows per batch.
 *
 * Body: RawEvent[] (see src/lib/raw-events-schema.ts for the shape)
 * Response: { ok: true, accepted, inserted, updated }
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

  const parsed = rawEventsBatchSchema.safeParse(body);
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

  const { data, error } = await supabase.rpc("upsert_raw_events", {
    p_user_id: auth.userId,
    p_rows: parsed.data,
  });
  if (error) {
    console.error("[raw_events] rpc error", error);
    return NextResponse.json({ error: "write failed" }, { status: 502 });
  }

  const counts = Array.isArray(data) && data[0] ? data[0] : { inserted: 0, updated: 0 };
  return NextResponse.json({
    ok: true,
    accepted: parsed.data.length,
    inserted: counts.inserted,
    updated: counts.updated,
  });
}
