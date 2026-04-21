import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAgentOrSessionAuth } from "@/lib/api-auth";
import {
  assembleCard,
  type ObservationRow,
  type PersonSnapshot,
} from "@/lib/card-assembler";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UUID_RE = /^[0-9a-f-]{36}$/i;

/**
 * GET /api/v1/person/:id/card
 *
 * Returns the current-best card for a person, assembled on read from
 * the observation basket. No materialized view in V0 — assembly is a
 * pure function over observations linked to this person.
 *
 * Response: { card: PersonCard } or 404 if the person doesn't exist.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid person id" }, { status: 400 });
  }

  const auth = await getAgentOrSessionAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim(),
  );

  // Parallel fetch:
  //  (1) select_person_card_rows — identity + correction rows + latest 500
  //      interactions. Under PostgREST's 1000-row cap. See
  //      supabase/migrations/20260421_select_person_card_rows_rpc.sql.
  //  (2) select_latest_summary_snapshot — Phase 2 per-pass snapshot
  //      (pass_kind='summary'), used as a headline override by the
  //      card-assembler when present. Non-fatal on error — falls back
  //      to observation-derived headline.
  const [cardRowsResult, summaryResult] = await Promise.all([
    supabase.rpc("select_person_card_rows", {
      p_user_id: auth.userId,
      p_person_id: id,
    }),
    supabase.rpc("select_latest_summary_snapshot", {
      p_user_id: auth.userId,
      p_person_id: id,
    }),
  ]);

  if (cardRowsResult.error) {
    console.error("[person/card] rpc error", cardRowsResult.error);
    return NextResponse.json({ error: "read failed" }, { status: 502 });
  }

  const rows = (Array.isArray(cardRowsResult.data)
    ? cardRowsResult.data
    : []) as ObservationRow[];

  // Summary snapshot is optional — log and ignore errors, don't fail the card.
  let summarySnapshot: PersonSnapshot | null = null;
  if (summaryResult.error) {
    console.warn(
      "[person/card] summary snapshot rpc warn",
      summaryResult.error.message,
    );
  } else if (Array.isArray(summaryResult.data) && summaryResult.data.length > 0) {
    summarySnapshot = summaryResult.data[0] as PersonSnapshot;
  }

  // Empty set could mean: (a) person doesn't exist, (b) person exists
  // but has no observations linked yet. Check persons table to
  // disambiguate; a 404 is more honest than an empty card when the
  // person doesn't exist at all.
  if (rows.length === 0) {
    const { data: personRow } = await supabase
      .from("persons")
      .select("id")
      .eq("id", id)
      .eq("user_id", auth.userId)
      .maybeSingle();
    if (!personRow) {
      return NextResponse.json({ error: "person not found" }, { status: 404 });
    }
  }

  const card = assembleCard(id, rows, summarySnapshot);
  return NextResponse.json({ card });
}
