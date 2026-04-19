import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAgentOrSessionAuth } from "@/lib/api-auth";
import { CORRECTION_SOURCES } from "@/lib/observations-schema";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UUID_RE = /^[0-9a-f-]{36}$/i;

const correctBodySchema = z.object({
  field: z.string().min(1).max(64),
  new_value: z.unknown(),
  old_value: z.unknown().optional().nullable(),
  source: z.enum(CORRECTION_SOURCES).default("other"),
  reasoning: z.string().min(1).max(2000).optional(),
});

/**
 * POST /api/v1/person/:id/correct
 *
 * Convenience wrapper that writes a single kind:"correction" observation
 * targeting this person. Used by Wazowski when relaying a founder
 * correction from Telegram or Decision-Tinder. For V0, confidence is
 * hardcoded to 1.0 (human ground truth by convention).
 *
 * Body: { field, new_value, old_value?, source?, reasoning? }
 * Response: { ok: true, observation: {inserted, deduped} }
 */
export async function POST(
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = correctBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid body", details: parsed.error.issues.slice(0, 10) },
      { status: 400 },
    );
  }

  const now = new Date().toISOString();
  const observation = {
    observed_at: now,
    observer: "wazowski",
    kind: "correction",
    evidence_pointer: `human://${parsed.data.source}/${Date.now()}`,
    confidence: 1,
    reasoning:
      parsed.data.reasoning ??
      `human correction relayed via ${parsed.data.source}`,
    payload: {
      target_person_id: id,
      field: parsed.data.field,
      old_value: parsed.data.old_value ?? null,
      new_value: parsed.data.new_value,
      source: parsed.data.source,
    },
  };

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim(),
  );

  const { data, error } = await supabase.rpc("upsert_observations", {
    p_user_id: auth.userId,
    p_rows: [observation],
  });
  if (error) {
    console.error("[person/correct] rpc error", error);
    return NextResponse.json({ error: "write failed" }, { status: 502 });
  }

  const counts = Array.isArray(data) && data[0] ? data[0] : { inserted: 0, deduped: 0 };
  return NextResponse.json({
    ok: true,
    observation: counts,
  });
}
