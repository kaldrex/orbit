import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAgentOrSessionAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

const boolMap = z.record(z.string(), z.boolean());

const reportSchema = z.object({
  agent_id: z.string().trim().min(1).max(120),
  hostname: z.string().trim().max(255).optional(),
  channels: boolMap,
  data_sources: boolMap,
  tools: boolMap,
});

interface CapabilityRow {
  agent_id: string;
  hostname: string | null;
  channels: Record<string, boolean> | null;
  data_sources: Record<string, boolean> | null;
  tools: Record<string, boolean> | null;
  reported_at: string;
}

/**
 * GET /api/v1/capabilities
 *
 * Returns the caller's reported agents, newest first. Used by the
 * onboarding UI to poll for a "hello" from the freshly-installed
 * OpenClaw plugin. Session auth required — agents should not read the
 * founder's full agent list via Bearer.
 *
 * Response: { agents: AgentReport[] }
 */
export async function GET(request: Request) {
  const auth = await getAgentOrSessionAuth(request);
  if (!auth) {
    return NextResponse.json(
      {
        error: {
          code: "unauthorized",
          message: "Sign in to view agent reports.",
        },
      },
      { status: 401 },
    );
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim(),
  );

  // Direct .from("capability_reports") returns 0 rows under the ANON key
  // because auth.uid() is null in anon context — so we route through a
  // SECURITY DEFINER RPC that takes user_id explicitly, same pattern as
  // select_enriched_persons + select_persons_page.
  const { data, error } = await supabase.rpc("select_capability_reports", {
    p_user_id: auth.userId,
  });

  if (error) {
    console.error("[capabilities] rpc error", error);
    return NextResponse.json(
      {
        error: {
          code: "read_failed",
          message: "Could not load agent reports.",
        },
      },
      { status: 502 },
    );
  }

  const rows = (Array.isArray(data) ? data : []) as CapabilityRow[];
  const agents = rows.map((r) => ({
    agentId: r.agent_id,
    hostname: r.hostname ?? "",
    channels: r.channels ?? {},
    dataSources: r.data_sources ?? {},
    tools: r.tools ?? {},
    reportedAt: r.reported_at,
  }));

  return NextResponse.json({ agents });
}

/**
 * POST /api/v1/capabilities
 *
 * Upserts a capability report from an OpenClaw agent. Bearer-auth
 * required (the agent owns its API key). One row per (user_id,
 * agent_id) — re-posting updates the existing row's counters +
 * reported_at via the `upsert_capability_report` RPC.
 *
 * Body: { agent_id, hostname?, channels, data_sources, tools }
 * Response: { ok: true, reported_at }
 */
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

  const parsed = reportSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "invalid_body",
          message: "Body failed schema validation.",
          suggestion:
            "Send { agent_id, hostname?, channels, data_sources, tools } where maps are Record<string,boolean>.",
        },
      },
      { status: 400 },
    );
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim(),
  );

  const { data, error } = await supabase.rpc("upsert_capability_report", {
    p_user_id: auth.userId,
    p_agent_id: parsed.data.agent_id,
    p_hostname: parsed.data.hostname ?? null,
    p_channels: parsed.data.channels,
    p_data_sources: parsed.data.data_sources,
    p_tools: parsed.data.tools,
  });
  if (error) {
    console.error("[capabilities] rpc error", error);
    return NextResponse.json(
      {
        error: {
          code: "write_failed",
          message: "Could not persist the capability report.",
        },
      },
      { status: 502 },
    );
  }

  // upsert_capability_report returns the row's reported_at timestamptz
  // directly — not a result row — so data is already the ISO string.
  const reportedAt: string =
    typeof data === "string" ? data : new Date().toISOString();

  return NextResponse.json({ ok: true, reported_at: reportedAt });
}
