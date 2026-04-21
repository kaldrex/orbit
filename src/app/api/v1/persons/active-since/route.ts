import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAgentOrSessionAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/v1/persons/active-since?since=<iso>&needs_enrichment=<bool>
 *
 * Returns person_ids with activity (observations or snapshots) since the
 * given timestamp. When needs_enrichment=true, drops anyone with a fresh
 * pass_kind='summary' snapshot (<7 days old).
 *
 * Powers the delta-bulk enricher (SKILL picks candidates via this).
 */
export async function GET(request: Request) {
  const auth = await getAgentOrSessionAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const sinceRaw = url.searchParams.get("since");
  const needsEnrichmentRaw = url.searchParams.get("needs_enrichment");

  if (!sinceRaw) {
    return NextResponse.json(
      { error: "since is required (ISO 8601 timestamp)" },
      { status: 400 },
    );
  }
  const sinceMs = Date.parse(sinceRaw);
  if (!Number.isFinite(sinceMs)) {
    return NextResponse.json({ error: "invalid since timestamp" }, { status: 400 });
  }

  const needsEnrichment = needsEnrichmentRaw === "true" || needsEnrichmentRaw === "1";

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim(),
  );

  const { data, error } = await supabase.rpc("select_persons_active_since", {
    p_user_id: auth.userId,
    p_since: new Date(sinceMs).toISOString(),
    p_needs_enrichment: needsEnrichment,
  });

  if (error) {
    console.error("[persons/active-since] rpc error", error);
    return NextResponse.json({ error: "read failed" }, { status: 502 });
  }

  const rows = (Array.isArray(data) ? data : []) as Array<{
    person_id: string;
    last_activity_at: string;
    activity_count: number;
  }>;

  return NextResponse.json({ persons: rows, total: rows.length });
}
