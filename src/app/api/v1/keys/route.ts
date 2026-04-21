import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAgentOrSessionAuth } from "@/lib/api-auth";
import { generateApiKey } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

// Name is now REQUIRED (1..120 chars after trim) and must be unique per user.
// See the header comment below for the idempotency contract.
const bodySchema = z.object({
  name: z.string().trim().min(1).max(120),
});

/**
 * POST /api/v1/keys
 *
 * Mints a new Orbit API key scoped to the caller's user_id. Session-auth
 * only (a valid browser login is required to mint) — agents cannot mint
 * new keys via Bearer auth. The raw `key` is returned exactly once; only
 * its SHA-256 hash is persisted via the `mint_api_key` RPC.
 *
 * Idempotency contract (added 2026-04-21 after the backend audit found
 * that `POST /keys {}` minted an unbounded pile of "agent"-named keys):
 *
 *   - `name` is required. Empty body / missing name → 400 `name_required`.
 *     No more silent fallback to "agent".
 *   - `name` must be unique per user among non-revoked keys. If the caller
 *     re-POSTs with the same name, we return 409 `name_exists` and include
 *     the existing key's prefix (safer than (b) silent no-op — a silent
 *     success would imply the caller has the raw key, which they do not).
 *   - Caller wanting to rotate a key must revoke the old one first, then
 *     mint with the same name. Reject-duplicate is the cheapest way to
 *     prevent accidental duplicate minting from a retry loop.
 *
 * Body: { name: string }  // 1..120 chars after trim
 * Response 200: { key, prefix, name, created_at }
 * Response 409: { error: { code: "name_exists", existing_prefix, … } }
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
    // Distinguish "missing name" from other schema failures — the audit
    // found bare `POST {}` calls were the primary offender.
    const bodyObj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const nameMissing =
      bodyObj.name === undefined ||
      bodyObj.name === null ||
      (typeof bodyObj.name === "string" && bodyObj.name.trim() === "");
    if (nameMissing) {
      return NextResponse.json(
        {
          error: {
            code: "name_required",
            message: "Provide a unique `name` for this key.",
            suggestion:
              "Send { name: string (1..120 chars) }. Names must be unique per user.",
          },
        },
        { status: 400 },
      );
    }
    return NextResponse.json(
      {
        error: {
          code: "invalid_body",
          message: "Body failed schema validation.",
          suggestion: "Send { name: string (1..120 chars) }.",
        },
      },
      { status: 400 },
    );
  }

  const name = parsed.data.name;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim(),
  );

  // Check for an existing non-revoked key with the same name, to keep the
  // mint idempotent. Reject with 409 so the caller notices the collision.
  const { data: existing, error: existingErr } = await supabase
    .from("api_keys")
    .select("prefix, created_at")
    .eq("user_id", auth.userId)
    .eq("name", name)
    .is("revoked_at", null)
    .maybeSingle();
  if (existingErr) {
    console.error("[keys] duplicate-check error", existingErr);
    return NextResponse.json(
      {
        error: {
          code: "mint_failed",
          message: "Could not check for duplicate key names.",
        },
      },
      { status: 502 },
    );
  }
  if (existing) {
    return NextResponse.json(
      {
        error: {
          code: "name_exists",
          message: `An active key named "${name}" already exists for this user.`,
          existing_prefix: existing.prefix,
          existing_created_at: existing.created_at,
          suggestion:
            "Revoke the old key first, or pick a different name.",
        },
      },
      { status: 409 },
    );
  }

  const minted = await generateApiKey(auth.userId, name);

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
