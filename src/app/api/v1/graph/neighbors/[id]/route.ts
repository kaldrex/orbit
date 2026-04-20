import { NextResponse } from "next/server";
import { getAgentOrSessionAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UUID_RE = /^[0-9a-f-]{36}$/i;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: { code: "INVALID_ID", message: "invalid person id" } },
      { status: 400 },
    );
  }

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
        code: "NEO4J_NOT_POPULATED",
        message: "Neo4j graph layer not yet populated; see doc 18.",
      },
    },
    { status: 503 },
  );
}
