import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAgentOrSessionAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/v1/jobs/report
 *
 * Mark a claimed job's outcome. Body:
 *   { job_id: uuid, status: 'succeeded'|'failed'|'retry',
 *     result?: jsonb, error?: string }
 *
 * On `status: "retry"` the row's claimed_at/by are cleared so the next
 * claim_next_job call can pick it up again (attempts keeps climbing).
 * On succeeded/failed we set completed_at and persist
 * `{status, data: result}` in the result column.
 */
const reportBodySchema = z.object({
  job_id: z.string().uuid(),
  status: z.enum(["succeeded", "failed", "retry"]),
  result: z.unknown().optional(),
  error: z.string().max(8000).nullable().optional(),
});

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

  const parsed = reportBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "invalid_body",
          message: "Body failed schema validation.",
          suggestion:
            "Send { job_id: '<uuid>', status: 'succeeded'|'failed'|'retry', result?: {...}, error?: '...' }.",
        },
      },
      { status: 400 },
    );
  }

  // Merge `error` into the result payload so the DB row carries both the
  // agent's structured output and any human-readable failure string.
  const resultPayload = {
    ...(parsed.data.result && typeof parsed.data.result === "object"
      ? (parsed.data.result as Record<string, unknown>)
      : parsed.data.result !== undefined
        ? { value: parsed.data.result }
        : {}),
    ...(parsed.data.error ? { error: parsed.data.error } : {}),
  };

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim(),
  );

  const { data, error } = await supabase.rpc("report_job_result", {
    p_job_id: parsed.data.job_id,
    p_user_id: auth.userId,
    p_status: parsed.data.status,
    p_result: resultPayload,
  });

  if (error) {
    console.error("[jobs/report] rpc error", error);
    return NextResponse.json(
      {
        error: {
          code: "report_failed",
          message: "Could not persist the job result.",
        },
      },
      { status: 502 },
    );
  }

  // RPC returns true when a row was updated, false when job_id didn't
  // match a row belonging to this user. Translate the latter to 404 so
  // clients can distinguish from 5xx.
  if (data === false) {
    return NextResponse.json(
      {
        error: {
          code: "not_found",
          message: "Job not found for this user.",
        },
      },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true });
}
