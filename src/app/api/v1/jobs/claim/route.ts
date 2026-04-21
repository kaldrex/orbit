import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAgentOrSessionAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/v1/jobs/claim
 *
 * Atomic claim over the jobs queue. Body: {agent: string, kinds: string[]}.
 * Returns {job: {id, kind, payload, attempts, created_at}} when a row was
 * claimed, {job: null} when the queue is empty / no match.
 *
 * Claw agents poll this from a systemd timer (every 15 min). The DB-side
 * RPC uses SELECT ... FOR UPDATE SKIP LOCKED so multiple pollers on the
 * same user never hand the same job out twice.
 */
const claimBodySchema = z.object({
  agent: z.string().trim().min(1).max(128),
  kinds: z.array(z.string().trim().min(1).max(64)).min(1).max(32),
});

interface ClaimedJobRow {
  id: string;
  kind: string;
  payload: unknown;
  attempts: number;
  created_at: string;
}

export async function POST(request: Request) {
  const auth = await getAgentOrSessionAuth(request);
  if (!auth) {
    return NextResponse.json(
      {
        error: {
          code: "unauthorized",
          message: "Valid API key or session required.",
        },
      },
      { status: 401 },
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          code: "invalid_json",
          message: "Request body must be JSON.",
        },
      },
      { status: 400 },
    );
  }

  const parsed = claimBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "invalid_body",
          message: "Body failed schema validation.",
          suggestion:
            "Send { agent: 'wazowski', kinds: ['observer','enricher',...] }.",
        },
      },
      { status: 400 },
    );
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim(),
  );

  const { data, error } = await supabase.rpc("claim_next_job", {
    p_user_id: auth.userId,
    p_agent_id: parsed.data.agent,
    p_kinds: parsed.data.kinds,
  });

  if (error) {
    console.error("[jobs/claim] rpc error", error);
    return NextResponse.json(
      {
        error: {
          code: "claim_failed",
          message: "Could not claim a job.",
        },
      },
      { status: 502 },
    );
  }

  const rows = (Array.isArray(data) ? data : []) as ClaimedJobRow[];
  if (rows.length === 0) {
    return NextResponse.json({ job: null });
  }

  const r = rows[0];
  return NextResponse.json({
    job: {
      id: r.id,
      kind: r.kind,
      payload: r.payload ?? {},
      attempts: r.attempts,
      created_at: r.created_at,
    },
  });
}
