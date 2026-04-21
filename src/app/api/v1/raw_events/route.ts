import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAgentOrSessionAuth } from "@/lib/api-auth";
import {
  RAW_EVENT_SOURCES,
  rawEventsBatchSchema,
  MAX_BATCH,
} from "@/lib/raw-events-schema";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const DEFAULT_READ_LIMIT = 200;
const MAX_READ_LIMIT = 1000;

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

/**
 * GET /api/v1/raw_events?source=<source>&limit=<n>&cursor=<iso8601>|<uuid>
 *
 * Cursor-paginated read over the caller's raw_events ledger. Ordered by
 * (occurred_at ASC, id ASC) so the backfill pipeline can fold
 * chronologically without re-sorting. Used by the onboarding backfill
 * verb `orbit_interactions_backfill` — projects raw_events into
 * interaction observations.
 *
 * Response: { events: RawEvent[], next_cursor: string | null }
 *
 * Cursor format: "<iso8601>|<uuid>" (last row of prior page). Opaque
 * to clients — just pass whatever next_cursor returned.
 */
export async function GET(request: Request) {
  const auth = await getAgentOrSessionAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const source = url.searchParams.get("source");
  const rawLimit = url.searchParams.get("limit");
  const rawCursor = url.searchParams.get("cursor");

  if (source && !RAW_EVENT_SOURCES.includes(source as (typeof RAW_EVENT_SOURCES)[number])) {
    return NextResponse.json(
      { error: "invalid source", allowed: RAW_EVENT_SOURCES },
      { status: 400 },
    );
  }

  let limit = DEFAULT_READ_LIMIT;
  if (rawLimit) {
    const n = parseInt(rawLimit, 10);
    if (!Number.isFinite(n) || n <= 0) {
      return NextResponse.json({ error: "invalid limit" }, { status: 400 });
    }
    limit = Math.min(n, MAX_READ_LIMIT);
  }

  let cursorOccurredAt: string | null = null;
  let cursorId: string | null = null;
  if (rawCursor) {
    const pipe = rawCursor.indexOf("|");
    if (pipe < 0) {
      return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
    }
    const isoPart = rawCursor.slice(0, pipe);
    const idPart = rawCursor.slice(pipe + 1);
    const d = new Date(isoPart);
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json({ error: "invalid cursor timestamp" }, { status: 400 });
    }
    if (!/^[0-9a-f-]{36}$/i.test(idPart)) {
      return NextResponse.json({ error: "invalid cursor id" }, { status: 400 });
    }
    cursorOccurredAt = d.toISOString();
    cursorId = idPart;
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim(),
  );

  const { data, error } = await supabase.rpc("select_raw_events", {
    p_user_id: auth.userId,
    p_source: source,
    p_cursor_occurred_at: cursorOccurredAt,
    p_cursor_id: cursorId,
    p_limit: limit,
  });
  if (error) {
    console.error("[raw_events] select rpc error", error);
    return NextResponse.json({ error: "read failed" }, { status: 502 });
  }

  const rows = Array.isArray(data) ? data : [];
  let next_cursor: string | null = null;
  if (rows.length === limit) {
    const last = rows[rows.length - 1];
    const iso = typeof last.occurred_at === "string"
      ? last.occurred_at
      : new Date(last.occurred_at).toISOString();
    next_cursor = `${iso}|${last.id}`;
  }

  return NextResponse.json({
    events: rows,
    next_cursor,
  });
}
