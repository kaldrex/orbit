import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAgentOrSessionAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UUID_RE = /^[0-9a-f-]{36}$/i;
const DEFAULT_GET_LIMIT = 50;
const MAX_GET_LIMIT = 200;
const MAX_DIFF_SUMMARY_LEN = 4000;
const MAX_EVIDENCE_POINTERS = 500;

const passKindSchema = z.enum(["enricher", "resolver", "summary", "correction"]);

const postBodySchema = z.object({
  pass_kind: passKindSchema,
  card_state: z.record(z.string(), z.any()).default({}),
  evidence_pointer_ids: z
    .array(z.string().regex(UUID_RE))
    .max(MAX_EVIDENCE_POINTERS)
    .default([]),
  diff_summary: z.string().max(MAX_DIFF_SUMMARY_LEN).default(""),
  confidence_delta: z.record(z.string(), z.any()).default({}),
});

/**
 * POST /api/v1/person/:id/snapshots
 *
 * Write one immutable per-pass snapshot of a person's card state. Called
 * by the enricher SKILL at the end of each pass and by the combiner SKILL
 * when generating a summary snapshot.
 *
 * Auth: Bearer (agent) OR session. Person ownership enforced inside the
 * SECURITY DEFINER RPC.
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

  const parsed = postBodySchema.safeParse(body);
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

  const { data, error } = await supabase.rpc("upsert_person_snapshot", {
    p_user_id: auth.userId,
    p_person_id: id,
    p_pass_kind: parsed.data.pass_kind,
    p_card_state: parsed.data.card_state,
    p_evidence_pointer_ids: parsed.data.evidence_pointer_ids,
    p_diff_summary: parsed.data.diff_summary,
    p_confidence_delta: parsed.data.confidence_delta,
  });

  if (error) {
    const msg = error.message || "";
    if (msg.includes("person_id not found")) {
      return NextResponse.json({ error: "person not found" }, { status: 404 });
    }
    if (msg.includes("different user")) {
      return NextResponse.json({ error: "person not found" }, { status: 404 });
    }
    console.error("[person/snapshots] upsert rpc error", error);
    return NextResponse.json({ error: "write failed" }, { status: 502 });
  }

  return NextResponse.json({ ok: true, id: data });
}

/**
 * GET /api/v1/person/:id/snapshots[?limit=50]
 *
 * Returns { snapshots: [...], total } in pass_at-desc order. Powers the
 * Evolution stack in PersonPanel.
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

  const url = new URL(request.url);
  const rawLimit = url.searchParams.get("limit");
  let limit = DEFAULT_GET_LIMIT;
  if (rawLimit) {
    const n = parseInt(rawLimit, 10);
    if (!Number.isFinite(n) || n <= 0) {
      return NextResponse.json({ error: "invalid limit" }, { status: 400 });
    }
    limit = Math.min(n, MAX_GET_LIMIT);
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim(),
  );

  const { data, error } = await supabase.rpc("select_person_snapshots", {
    p_user_id: auth.userId,
    p_person_id: id,
    p_limit: limit,
  });

  if (error) {
    console.error("[person/snapshots] select rpc error", error);
    return NextResponse.json({ error: "read failed" }, { status: 502 });
  }

  const snapshots = Array.isArray(data) ? data : [];
  return NextResponse.json({ snapshots, total: snapshots.length });
}
