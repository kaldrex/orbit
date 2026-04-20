import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAgentOrSessionAuth } from "@/lib/api-auth";
import {
  assembleCard,
  type ObservationRow,
} from "@/lib/card-assembler";

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
  updated_at: string | null;
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
 * Used by manifest-gen's enrichment-preservation loop (Phase C3) so
 * regenerating the manifest does NOT overwrite LLM-enriched fields.
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

  // Page through persons via select_persons_page RPC (SECURITY DEFINER) —
  // mirrors the bypass-RLS pattern used by select_observations +
  // select_person_observations. Direct .from("persons") hits RLS under the
  // ANON key and returns nothing, so the RPC is load-bearing.
  const pageSize = limit;
  const { data: personRows, error: personsError } = await supabase.rpc(
    "select_persons_page",
    {
      p_user_id: auth.userId,
      p_cursor: cursor ?? null,
      p_limit: pageSize,
    },
  );
  if (personsError) {
    console.error("[persons/enriched] persons error", personsError);
    return NextResponse.json({ error: "read failed" }, { status: 502 });
  }

  const ids = (Array.isArray(personRows) ? personRows : []).map(
    (r) => (r as { id: string }).id,
  );
  if (ids.length === 0) {
    return NextResponse.json({ persons: [], next_cursor: null });
  }

  const persons: EnrichedPerson[] = [];
  for (const id of ids) {
    const { data: rpcData, error: obsError } = await supabase.rpc(
      "select_person_observations",
      { p_user_id: auth.userId, p_person_id: id },
    );
    if (obsError) {
      console.error("[persons/enriched] obs error", id, obsError);
      continue;
    }
    const rows = (Array.isArray(rpcData) ? rpcData : []) as ObservationRow[];
    if (rows.length === 0) continue;
    const card = assembleCard(id, rows);
    const categoryEnriched =
      !!card.category && card.category !== "other";
    const relEnriched =
      typeof card.relationship_to_me === "string" &&
      card.relationship_to_me.length > 0 &&
      !card.relationship_to_me.startsWith("Appears in");
    if (!categoryEnriched && !relEnriched) continue;
    const latestObservedAt = rows
      .map((r) => r.observed_at)
      .sort()
      .slice(-1)[0] ?? null;
    persons.push({
      id,
      name: card.name,
      phones: card.phones,
      emails: card.emails,
      category: card.category,
      relationship_to_me: card.relationship_to_me,
      company: card.company,
      title: card.title,
      updated_at: latestObservedAt,
    });
  }

  // Cursor is the id of the last row in the underlying page (not of the
  // filtered persons), so pagination does not "skip" filtered rows.
  const next_cursor =
    ids.length === pageSize ? ids[ids.length - 1] : null;

  return NextResponse.json({ persons, next_cursor });
}
