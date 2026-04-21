import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAgentOrSessionAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UUID_RE = /^[0-9a-f-]{36}$/i;
const MAX_TOPICS = 50;
const MAX_TOPIC_LEN = 80;
const DEFAULT_GET_LIMIT = 10;
const MAX_GET_LIMIT = 50;

const topicSchema = z.object({
  topic: z.string().min(1).max(MAX_TOPIC_LEN),
  weight: z.number().finite(),
});

const postBodySchema = z.object({
  topics: z.array(topicSchema).max(MAX_TOPICS),
});

/**
 * POST /api/v1/person/:id/topics
 *
 * Atomic replace of topic weights for one person. Body:
 *   { "topics": [ { "topic": string, "weight": number } ] }
 *
 * Each call fully replaces any prior topics for (user_id, person_id).
 * Returns { count } where count is the number of rows written.
 *
 * Auth: Bearer (agent) OR session. Person ownership is enforced by the
 * SECURITY DEFINER RPC — upsert_person_topics returns -1 if the
 * person_id doesn't belong to the authed user.
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

  // Collapse duplicate topics client-side (last-wins) and drop empties
  // before handing to the RPC. The RPC trims + lowercases too; this
  // keeps the returned count honest.
  const normalized = new Map<string, number>();
  for (const t of parsed.data.topics) {
    const key = t.topic.trim().toLowerCase();
    if (!key) continue;
    normalized.set(key, t.weight);
  }
  const topicsPayload = Array.from(normalized, ([topic, weight]) => ({ topic, weight }));

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim(),
  );

  const { data, error } = await supabase.rpc("upsert_person_topics", {
    p_user_id: auth.userId,
    p_person_id: id,
    p_topics: topicsPayload,
  });
  if (error) {
    console.error("[person/topics] upsert rpc error", error);
    return NextResponse.json({ error: "write failed" }, { status: 502 });
  }

  const count = typeof data === "number" ? data : Number(data);
  if (count === -1) {
    return NextResponse.json({ error: "person not found" }, { status: 404 });
  }

  return NextResponse.json({ count: Math.max(0, count) });
}

/**
 * GET /api/v1/person/:id/topics[?limit=10]
 *
 * Returns { topics: [{ topic, weight }], total } sorted by weight desc.
 * limit defaults to 10, max 50.
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

  const { data, error } = await supabase.rpc("select_person_topics", {
    p_user_id: auth.userId,
    p_person_id: id,
    p_limit: limit,
  });
  if (error) {
    console.error("[person/topics] select rpc error", error);
    return NextResponse.json({ error: "read failed" }, { status: 502 });
  }

  const rows = (Array.isArray(data) ? data : []) as Array<{ topic: string; weight: number | string }>;
  const topics = rows.map((r) => ({ topic: r.topic, weight: Number(r.weight) }));
  return NextResponse.json({ topics, total: topics.length });
}
