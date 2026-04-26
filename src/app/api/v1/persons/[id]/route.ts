import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAgentOrSessionAuth } from "@/lib/api-auth";
import { assembleCard, type ObservationRow } from "@/lib/card-assembler";
import { PERSON_CATEGORIES } from "@/lib/observations-schema";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UUID_RE = /^[0-9a-f-]{36}$/i;
const updateSchema = z.object({
  company: z.string().trim().max(256).nullable().optional(),
  title: z.string().trim().max(256).nullable().optional(),
  category: z.enum(PERSON_CATEGORIES).optional(),
  relationship_strength: z.string().trim().max(64).nullable().optional(),
  relationship_to_me: z.string().trim().max(2000).optional(),
  name: z.string().trim().min(1).max(256).optional(),
}).strict();

const fields = [
  "company",
  "title",
  "category",
  "relationship_strength",
  "relationship_to_me",
  "name",
] as const;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid person id" }, { status: 400 });
  }

  const auth = await getAgentOrSessionAuth(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid body", details: parsed.error.issues.slice(0, 10) },
      { status: 400 },
    );
  }
  const requested = fields.filter((field) => field in parsed.data);
  if (requested.length === 0) {
    return NextResponse.json({ error: "no fields to update" }, { status: 400 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim(),
  );

  const { data: cardRows, error: cardError } = await supabase.rpc(
    "select_person_card_rows",
    { p_user_id: auth.userId, p_person_id: id },
  );
  if (cardError) {
    console.error("[persons/:id] card rpc error", cardError);
    return NextResponse.json({ error: "read failed" }, { status: 502 });
  }

  const rows = (Array.isArray(cardRows) ? cardRows : []) as ObservationRow[];
  if (rows.length === 0) {
    const { data: personRow } = await supabase
      .from("persons")
      .select("id")
      .eq("id", id)
      .eq("user_id", auth.userId)
      .maybeSingle();
    if (!personRow) return NextResponse.json({ error: "person not found" }, { status: 404 });
  }

  const card = assembleCard(id, rows);
  const now = new Date().toISOString();
  const observations = requested
    .filter((field) => parsed.data[field] !== card[field])
    .map((field) => ({
      observed_at: now,
      observer: "wazowski",
      kind: "correction",
      evidence_pointer: `hermes://patch/person/${id}/${field}/${now}`,
      confidence: 1,
      reasoning: `Hermes updated ${field} for person ${id}.`,
      payload: {
        target_person_id: id,
        field,
        old_value: card[field] ?? null,
        new_value: parsed.data[field],
        source: "other",
      },
    }));

  if (observations.length === 0) {
    return NextResponse.json({
      ok: true,
      person_id: id,
      updated_fields: [],
      observation: { inserted: 0, deduped: 0, inserted_ids: [] },
    });
  }

  const { data, error } = await supabase.rpc("upsert_observations", {
    p_user_id: auth.userId,
    p_rows: observations,
  });
  if (error) {
    console.error("[persons/:id] rpc error", error);
    return NextResponse.json({ error: "write failed" }, { status: 502 });
  }

  const observation = Array.isArray(data) && data[0]
    ? data[0]
    : { inserted: 0, deduped: 0, inserted_ids: [] };
  return NextResponse.json({
    ok: true,
    person_id: id,
    updated_fields: observations.map((o) => o.payload.field),
    observation,
  });
}
