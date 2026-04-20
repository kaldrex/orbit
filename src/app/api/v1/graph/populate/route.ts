import { NextResponse } from "next/server";
import { getAgentOrSessionAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const auth = await getAgentOrSessionAuth(request);
  if (!auth) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 },
    );
  }

  return NextResponse.json(
    {
      error: {
        code: "NOT_IMPLEMENTED",
        message:
          "Graph populate is scaffolded but not wired; see agent-docs/18-neo4j-edge-model-proposal.md.",
      },
    },
    { status: 501 },
  );
}
