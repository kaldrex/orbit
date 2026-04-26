import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAgentOrSessionAuth } from "@/lib/api-auth";
import { assembleCard, type ObservationRow } from "@/lib/card-assembler";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UUID_RE = /^[0-9a-f-]{36}$/i;

const bodySchema = z.object({
  person_id: z.string().uuid(),
  email: z.string().trim().toLowerCase().email().max(256),
  source: z.string().trim().min(1).max(64).default("other"),
  confidence: z.number().min(0).max(1).default(1),
});

function evidenceSource(source: string): string {
  const normalized = source.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return normalized || "other";
}

/**
 * POST /api/v1/observation
 *
 * Compatibility write endpoint for Hermes' email-resolution loop.
 * Appends the resolved email to the target person's current email set by
 * writing a normal kind:"correction" observation.
 *
 * Body: { person_id, email, source, confidence }
 * Response: { ok, person_id, email, observation }
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

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid body", details: parsed.error.issues.slice(0, 10) },
      { status: 400 },
    );
  }

  const { person_id, email, source, confidence } = parsed.data;
  if (!UUID_RE.test(person_id)) {
    return NextResponse.json({ error: "invalid person_id" }, { status: 400 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim(),
  );

  const { data: cardRows, error: cardError } = await supabase.rpc(
    "select_person_card_rows",
    {
      p_user_id: auth.userId,
      p_person_id: person_id,
    },
  );
  if (cardError) {
    console.error("[observation] card rpc error", cardError);
    return NextResponse.json({ error: "read failed" }, { status: 502 });
  }

  const rows = (Array.isArray(cardRows) ? cardRows : []) as ObservationRow[];
  if (rows.length === 0) {
    const { data: personRow } = await supabase
      .from("persons")
      .select("id")
      .eq("id", person_id)
      .eq("user_id", auth.userId)
      .maybeSingle();
    if (!personRow) {
      return NextResponse.json({ error: "person not found" }, { status: 404 });
    }
  }

  const card = assembleCard(person_id, rows);
  const emails = Array.from(new Set([...card.emails, email]));
  const now = new Date().toISOString();
  const sourceSlug = evidenceSource(source);

  const observation = {
    observed_at: now,
    observer: "wazowski",
    kind: "correction",
    evidence_pointer: `hermes://${sourceSlug}/email/${person_id}/${email}/${Date.now()}`,
    confidence,
    reasoning: `Hermes resolved ${email} for person ${person_id} from ${source}.`,
    payload: {
      target_person_id: person_id,
      field: "emails",
      old_value: card.emails,
      new_value: emails,
      source: "other",
    },
  };

  const { data, error } = await supabase.rpc("upsert_observations", {
    p_user_id: auth.userId,
    p_rows: [observation],
  });
  if (error) {
    console.error("[observation] rpc error", error);
    return NextResponse.json({ error: "write failed" }, { status: 502 });
  }

  const counts = Array.isArray(data) && data[0]
    ? data[0]
    : { inserted: 0, deduped: 0, inserted_ids: [] as string[] };

  return NextResponse.json({
    ok: true,
    person_id,
    email,
    observation: counts,
  });
}
