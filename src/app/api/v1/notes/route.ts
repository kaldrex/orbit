import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAgentOrSessionAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const bodySchema = z.object({
  person_id: z.string().uuid(),
  content: z.string().trim().min(1).max(5000),
  source: z.string().trim().min(1).max(128),
  created_at: z.string().datetime({ offset: true }).optional(),
});

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "hermes";
}

export async function POST(request: Request) {
  const auth = await getAgentOrSessionAuth(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim(),
  );
  const { data: personRow } = await supabase
    .from("persons")
    .select("id")
    .eq("id", parsed.data.person_id)
    .eq("user_id", auth.userId)
    .maybeSingle();
  if (!personRow) return NextResponse.json({ error: "person not found" }, { status: 404 });

  const observedAt = parsed.data.created_at ?? new Date().toISOString();
  const sourceSlug = slug(parsed.data.source);
  const observation = {
    observed_at: observedAt,
    observer: "wazowski",
    kind: "note",
    evidence_pointer: `hermes://${sourceSlug}/note/${parsed.data.person_id}/${observedAt}`,
    confidence: 1,
    reasoning: `Hermes attached a person note from ${parsed.data.source}.`,
    payload: {
      target_person_id: parsed.data.person_id,
      content: parsed.data.content,
      source: parsed.data.source,
    },
  };

  const { data, error } = await supabase.rpc("upsert_observations", {
    p_user_id: auth.userId,
    p_rows: [observation],
  });
  if (error) {
    console.error("[notes] rpc error", error);
    return NextResponse.json({ error: "write failed" }, { status: 502 });
  }

  const note = Array.isArray(data) && data[0]
    ? data[0]
    : { inserted: 0, deduped: 0, inserted_ids: [] };
  return NextResponse.json({ ok: true, person_id: parsed.data.person_id, note });
}
