import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAgentOrSessionAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/v1/self/init
 *
 * Resolves the authed user's own person_id by matching ORBIT_SELF_EMAIL
 * (optionally comma-separated to cover the founder's aliases) against the
 * `payload.emails` of their `kind:"person"` observations. Falls back to
 * ORBIT_SELF_PHONE against `payload.phones`.
 *
 * Writes the resolved id to profiles.self_node_id via the
 * `resolve_self_node_id` SECURITY DEFINER RPC.
 *
 * Idempotent: when profiles.self_node_id is already set, returns it
 * without rescanning observations.
 *
 * Response: { self_node_id: string } — or 404 with error.code = "NOT_FOUND"
 * when neither email nor phone resolves to an observation.
 */
export async function POST(request: Request) {
  const auth = await getAgentOrSessionAuth(request);
  if (!auth) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 },
    );
  }

  // Short-circuit when the profile already has a self_node_id.
  if (auth.selfNodeId && auth.selfNodeId.length > 0) {
    return NextResponse.json({ self_node_id: auth.selfNodeId });
  }

  const rawEmail = (process.env.ORBIT_SELF_EMAIL || "").trim();
  const rawPhone = (process.env.ORBIT_SELF_PHONE || "").trim();

  const emails = rawEmail
    ? rawEmail
        .split(",")
        .map((e) => e.trim())
        .filter((e) => e.length > 0)
    : [];
  const phones = rawPhone
    ? rawPhone
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
    : [];

  if (emails.length === 0 && phones.length === 0) {
    return NextResponse.json(
      {
        error: {
          code: "NO_IDENTITY_CONFIGURED",
          message:
            "ORBIT_SELF_EMAIL or ORBIT_SELF_PHONE must be set to resolve self_node_id.",
        },
      },
      { status: 404 },
    );
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim(),
  );

  const { data, error } = await supabase.rpc("resolve_self_node_id", {
    p_user_id: auth.userId,
    p_emails: emails,
    p_phones: phones,
  });

  if (error) {
    console.error("[self/init] resolve_self_node_id rpc error", error);
    return NextResponse.json(
      { error: { code: "RESOLVE_FAILED", message: "self-resolve failed" } },
      { status: 502 },
    );
  }

  const resolved = typeof data === "string" ? data : null;
  if (!resolved) {
    return NextResponse.json(
      {
        error: {
          code: "NOT_FOUND",
          message:
            "No `kind:person` observation matched ORBIT_SELF_EMAIL/ORBIT_SELF_PHONE.",
        },
      },
      { status: 404 },
    );
  }

  return NextResponse.json({ self_node_id: resolved });
}
