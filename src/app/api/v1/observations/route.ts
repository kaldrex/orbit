import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAgentOrSessionAuth } from "@/lib/api-auth";
import {
  OBSERVATION_KINDS,
  observationsBatchSchema,
  MAX_BATCH,
} from "@/lib/observations-schema";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const DEFAULT_READ_LIMIT = 100;
const MAX_READ_LIMIT = 1000;

/**
 * POST /api/v1/observations
 *
 * Append-only insert into the observation basket. Idempotent via a
 * DB-computed `dedup_key` (SHA-256 over kind + evidence_pointer + a
 * correction-specific tail). Re-posting the same observation is a
 * no-op at Postgres level. Max 100 rows per batch.
 *
 * Body: Observation[] (see src/lib/observations-schema.ts)
 * Response: { ok: true, accepted, inserted, deduped, inserted_ids }
 *
 * `inserted_ids` lists the uuid of every row that actually landed (in
 * batch order, skipping dedup hits). Clients that need to follow up with
 * a dependent write (e.g. AddContactDialog posting a kind:"merge" right
 * after a kind:"person") read it from here.
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

  const row = Array.isArray(data) && data[0]
    ? data[0]
    : { inserted: 0, deduped: 0, inserted_ids: [] as string[] };
  const insertedIds: string[] = Array.isArray(row.inserted_ids)
    ? row.inserted_ids
    : [];
  return NextResponse.json({
    ok: true,
    accepted: parsed.data.length,
    inserted: row.inserted,
    deduped: row.deduped,
    inserted_ids: insertedIds,
  });
}

/**
 * GET /api/v1/observations?since=<iso>&kind=<kind>&limit=<n>&cursor=<uuid>
 *
 * Cursor-paginated read over the caller's basket. Ordered by
 * (observed_at DESC, id DESC). Used by:
 *   - orbit-resolver skill on claw (pulls recent observations to cluster)
 *   - debug / verification checks
 *
 * Response: { observations: Observation[], next_cursor: uuid | null }
 */
export async function GET(request: Request) {
  const auth = await getAgentOrSessionAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const since = url.searchParams.get("since");
  const kind = url.searchParams.get("kind");
  const rawLimit = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");

  if (kind && !OBSERVATION_KINDS.includes(kind as (typeof OBSERVATION_KINDS)[number])) {
    return NextResponse.json(
      { error: "invalid kind", allowed: OBSERVATION_KINDS },
      { status: 400 },
    );
  }

  let sinceIso: string | null = null;
  if (since) {
    const d = new Date(since);
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json({ error: "invalid since" }, { status: 400 });
    }
    sinceIso = d.toISOString();
  }

  let limit = DEFAULT_READ_LIMIT;
  if (rawLimit) {
    const n = parseInt(rawLimit, 10);
    if (!Number.isFinite(n) || n <= 0) {
      return NextResponse.json({ error: "invalid limit" }, { status: 400 });
    }
    limit = Math.min(n, MAX_READ_LIMIT);
  }

  if (cursor && !/^[0-9a-f-]{36}$/i.test(cursor)) {
    return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim(),
  );

  const { data, error } = await supabase.rpc("select_observations", {
    p_user_id: auth.userId,
    p_since: sinceIso,
    p_kind: kind,
    p_limit: limit,
    p_cursor: cursor,
  });
  if (error) {
    console.error("[observations] select rpc error", error);
    return NextResponse.json({ error: "read failed" }, { status: 502 });
  }

  const rows = Array.isArray(data) ? data : [];
  const next_cursor = rows.length === limit ? rows[rows.length - 1].id : null;

  return NextResponse.json({
    observations: rows,
    next_cursor,
  });
}
