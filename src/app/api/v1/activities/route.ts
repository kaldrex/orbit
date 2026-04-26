import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAgentOrSessionAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const bodySchema = z.object({
  person_id: z.string().uuid(),
  type: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(256),
  occurred_at: z.string().datetime({ offset: true }),
  duration_minutes: z.number().int().positive().max(24 * 60).optional(),
  source: z.string().trim().min(1).max(128).default("hermes"),
  notes: z.string().trim().max(2000).optional(),
  action_items: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
  outcome: z.string().trim().max(128).optional(),
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

  const sourceSlug = slug(parsed.data.source);
  const titleSlug = slug(parsed.data.title).slice(0, 96);
  const observation = {
    observed_at: parsed.data.occurred_at,
    observer: "wazowski",
    kind: "interaction",
    evidence_pointer:
      `hermes://${sourceSlug}/activity/${parsed.data.person_id}/${parsed.data.occurred_at}/${titleSlug}`,
    confidence: 1,
    reasoning: `Hermes logged ${parsed.data.type} activity from ${parsed.data.source}.`,
    payload: {
      participants: [parsed.data.person_id],
      channel: parsed.data.type === "meeting" ? "meeting" : "slack",
      summary: parsed.data.notes || parsed.data.title,
      topic: "business",
      relationship_context: "",
      connection_context: "",
      sentiment: "neutral",
      target_person_id: parsed.data.person_id,
      activity_type: parsed.data.type,
      title: parsed.data.title,
      duration_minutes: parsed.data.duration_minutes,
      action_items: parsed.data.action_items,
      outcome: parsed.data.outcome,
      source: parsed.data.source,
    },
  };

  const { data, error } = await supabase.rpc("upsert_observations", {
    p_user_id: auth.userId,
    p_rows: [observation],
  });
  if (error) {
    console.error("[activities] rpc error", error);
    return NextResponse.json({ error: "write failed" }, { status: 502 });
  }

  const activity = Array.isArray(data) && data[0]
    ? data[0]
    : { inserted: 0, deduped: 0, inserted_ids: [] };
  return NextResponse.json({ ok: true, person_id: parsed.data.person_id, activity });
}
