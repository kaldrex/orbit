import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAgentOrSessionAuth } from "@/lib/api-auth";
import { generateApiKey } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

const bodySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
});

/**
 * POST /api/v1/keys
 *
 * Mints a new Orbit API key scoped to the caller's user_id. Session-auth
 * only (a valid browser login is required to mint) — agents cannot mint
 * new keys via Bearer auth. The raw `key` is returned exactly once; only
 * its SHA-256 hash is persisted via the `mint_api_key` RPC.
 *
 * Body: { name?: string }
 * Response: { key, prefix, name, created_at }
 */
export async function POST(request: Request) {
  const auth = await getAgentOrSessionAuth(request);
  if (!auth) {
    return NextResponse.json(
      {
        error: {
          code: "unauthorized",
          message: "Sign in to mint an API key.",
        },
      },
      { status: 401 },
    );
  }

  let raw: unknown = {};
  try {
    const text = await request.text();
    if (text) raw = JSON.parse(text);
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

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "invalid_body",
          message: "Body failed schema validation.",
          suggestion: "Send { name?: string (1..120 chars) }.",
        },
      },
      { status: 400 },
    );
  }

  const name = parsed.data.name ?? "agent";
  const minted = await generateApiKey(auth.userId, name);

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim(),
  );

  const { data, error } = await supabase.rpc("mint_api_key", {
    p_user_id: auth.userId,
    p_key_hash: minted.hash,
    p_prefix: minted.prefix,
    p_name: name,
  });
  if (error) {
    console.error("[keys] mint_api_key rpc error", error);
    return NextResponse.json(
      {
        error: {
          code: "mint_failed",
          message: "Could not persist the new key.",
        },
      },
      { status: 502 },
    );
  }

  const row = Array.isArray(data) ? data[0] : data;
  const createdAt: string =
    row?.created_at ?? new Date().toISOString();

  return NextResponse.json({
    key: minted.key,
    prefix: minted.prefix,
    name,
    created_at: createdAt,
  });
}
