import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAgentOrSessionAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

interface EnrichedPerson {
  id: string;
  name: string | null;
  phones: string[];
  emails: string[];
  category: string | null;
  relationship_to_me: string;
  company: string | null;
  title: string | null;
  relationship_strength: string | null;
  updated_at: string | null;
  last_activity: {
    type: string | null;
    title: string | null;
    occurred_at: string;
    days_ago: number;
  } | null;
  activity_count: number;
}

interface EnrichedRpcRow {
  id: string;
  name: string | null;
  phones: string[] | null;
  emails: string[] | null;
  category: string | null;
  relationship_to_me: string | null;
  company: string | null;
  title: string | null;
  relationship_strength: string | null;
  updated_at: string | null;
  last_activity: EnrichedPerson["last_activity"];
  activity_count: number | null;
  page_last_id: string | null;
}

/**
 * GET /api/v1/persons/enriched
 *
 * Returns persons whose latest-wins card has EITHER:
 *   - a non-"other" category, OR
 *   - a non-empty relationship_to_me that is not the legacy
 *     "Appears in N threads..." placeholder prose.
 *
 * Cursor-paginated. Auth via Bearer. Honors RLS (caller only sees
 * their own persons).
 *
 * Backed by the `select_enriched_persons` SECURITY DEFINER RPC which
 * performs the fold + filter server-side — no per-person round-trip.
 *
 * Response shape: { persons: EnrichedPerson[], next_cursor: string | null }
 */
export async function GET(request: Request) {
  const auth = await getAgentOrSessionAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const rawLimit = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");

  let limit = DEFAULT_LIMIT;
  if (rawLimit) {
    const n = parseInt(rawLimit, 10);
    if (!Number.isFinite(n) || n <= 0) {
      return NextResponse.json({ error: "invalid limit" }, { status: 400 });
    }
    limit = Math.min(n, MAX_LIMIT);
  }

  if (cursor && !/^[0-9a-f-]{36}$/i.test(cursor)) {
    return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim(),
  );

  const { data, error } = await supabase.rpc("select_enriched_persons", {
    p_user_id: auth.userId,
    p_cursor: cursor ?? null,
    p_limit: limit,
  });
  if (error) {
    console.error("[persons/enriched] rpc error", error);
    return NextResponse.json({ error: "read failed" }, { status: 502 });
  }

  const rows = (Array.isArray(data) ? data : []) as EnrichedRpcRow[];

  // page_last_id is identical across every row; NULL signals "short page,
  // no next cursor". The RPC also emits a sentinel row with id=NULL when
  // the page was full but every person was filtered out — so the caller
  // can keep paging. Skip sentinel rows when building persons[].
  const persons: EnrichedPerson[] = rows
    .filter((r) => r.id !== null)
    .map((r) => ({
      id: r.id,
      name: r.name,
      phones: r.phones ?? [],
      emails: r.emails ?? [],
      category: r.category,
      relationship_to_me: r.relationship_to_me ?? "",
      company: r.company,
      title: r.title,
      relationship_strength: r.relationship_strength,
      updated_at: r.updated_at,
      last_activity: r.last_activity,
      activity_count: r.activity_count ?? 0,
    }));

  const next_cursor = rows.length > 0 ? rows[0].page_last_id : null;

  return NextResponse.json({ persons, next_cursor });
}
