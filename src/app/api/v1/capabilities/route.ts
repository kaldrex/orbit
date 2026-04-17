import { NextRequest, NextResponse } from "next/server";
import { getAgentOrSessionAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/capabilities  — plugin reports what channels/data-sources/tools are wired
 * GET  /api/capabilities  — onboarding UI reads the latest report for the signed-in user
 *
 * Stored in-memory for now (per serverless instance). Production persistence
 * to Supabase is a follow-up once the service-role client is set up.
 */

type CapabilityReport = {
  agentId: string;
  hostname: string;
  channels: Record<string, boolean>;
  dataSources: Record<string, boolean>;
  tools: Record<string, boolean>;
  reportedAt: string;
};

// Module-level store: Map<userId, Map<agentId, report>>
// Note: this resets on cold start. Fine for MVP onboarding UX.
const store = new Map<string, Map<string, CapabilityReport>>();

function setReport(userId: string, report: CapabilityReport) {
  if (!store.has(userId)) store.set(userId, new Map());
  store.get(userId)!.set(report.agentId, report);
}

function getReports(userId: string): CapabilityReport[] {
  const agents = store.get(userId);
  if (!agents) return [];
  return Array.from(agents.values()).sort((a, b) =>
    b.reportedAt.localeCompare(a.reportedAt)
  );
}

export async function POST(request: NextRequest) {
  const auth = await getAgentOrSessionAuth(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid report" }, { status: 400 });
  }

  const report: CapabilityReport = {
    agentId: (body.agentId as string) || "main",
    hostname: (body.hostname as string) || "",
    channels: (body.channels as Record<string, boolean>) || {},
    dataSources: (body.dataSources as Record<string, boolean>) || {},
    tools: (body.tools as Record<string, boolean>) || {},
    reportedAt: new Date().toISOString(),
  };

  setReport(auth.userId, report);
  return NextResponse.json({ ok: true });
}

export async function GET(request: NextRequest) {
  const auth = await getAgentOrSessionAuth(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const agents = getReports(auth.userId);
  return NextResponse.json({ agents });
}
