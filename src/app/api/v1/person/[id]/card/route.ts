import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAgentOrSessionAuth } from "@/lib/api-auth";
import { assembleCard, type ObservationRow } from "@/lib/card-assembler";

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

  const { data, error } = await supabase.rpc("select_person_observations", {
    p_user_id: auth.userId,
    p_person_id: id,
  });
  if (error) {
    console.error("[person/card] rpc error", error);
    return NextResponse.json({ error: "read failed" }, { status: 502 });
  }

  const rows = (Array.isArray(data) ? data : []) as ObservationRow[];

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

  const card = assembleCard(id, rows);
  return NextResponse.json({ card });
}
