import { NextRequest, NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth";
import { generateApiKey } from "@/lib/api-auth";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

async function getSupabase() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        },
      },
    }
  );
}

/**
 * GET /api/keys — list user's API keys (prefix only, no secrets)
 */
export async function GET() {
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = await getSupabase();
  const { data: keys } = await supabase
    .from("api_keys")
    .select("id, name, key_prefix, scopes, last_used_at, created_at")
    .eq("user_id", auth.userId)
    .order("created_at", { ascending: false });

  return NextResponse.json({ keys: keys ?? [] });
}

/**
 * POST /api/keys — generate a new API key and store its hash
 * Returns the plaintext key ONCE.
 */
export async function POST(request: NextRequest) {
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const name = body.name || "Untitled key";

  const { key, hash, prefix } = await generateApiKey(auth.userId, name);

  const supabase = await getSupabase();
  const { error } = await supabase.from("api_keys").insert({
    user_id: auth.userId,
    name,
    key_hash: hash,
    key_prefix: prefix,
  });

  if (error) {
    return NextResponse.json({ error: "Failed to create key: " + error.message }, { status: 500 });
  }

  return NextResponse.json({
    key,
    prefix,
    name,
    message: "Save this key — you won't be able to see it again.",
  });
}

/**
 * DELETE /api/keys — revoke an API key by ID
 * Body: { id: "key-uuid" }
 */
export async function DELETE(request: NextRequest) {
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  if (!body.id) return NextResponse.json({ error: "Key ID required" }, { status: 400 });

  const supabase = await getSupabase();
  const { error } = await supabase
    .from("api_keys")
    .delete()
    .eq("id", body.id)
    .eq("user_id", auth.userId); // RLS ensures they can only delete their own

  if (error) {
    return NextResponse.json({ error: "Failed to revoke key" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, message: "API key revoked" });
}
