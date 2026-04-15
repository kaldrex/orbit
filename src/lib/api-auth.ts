import { createHash, randomBytes } from "crypto";
import { createClient } from "@supabase/supabase-js";

// Use anon key + security definer functions — no service role key needed
function getPublicClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

export async function generateApiKey(userId: string, name: string) {
  const raw = `orb_live_${randomBytes(24).toString("base64url")}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  const prefix = raw.slice(0, 12);

  // Insert via RPC or direct — needs service role for insert.
  // For now, generate key + hash client-side, insert via authenticated session.
  return { key: raw, hash, prefix, name };
}

export async function validateApiKey(authHeader: string | null): Promise<string | null> {
  if (!authHeader) return null;

  const key = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
  if (!key.startsWith("orb_live_")) return null;

  const hash = createHash("sha256").update(key).digest("hex");
  const supabase = getPublicClient();

  // Call security definer function — bypasses RLS
  const { data: userId } = await supabase.rpc("validate_api_key", { key_hash_input: hash });
  if (!userId) return null;

  return userId as string;
}

export async function getAgentOrSessionAuth(request: Request): Promise<{
  userId: string;
  selfNodeId: string | null;
} | null> {
  // Try API key first
  const authHeader = request.headers.get("authorization");
  const apiKeyUserId = await validateApiKey(authHeader);

  if (apiKeyUserId) {
    const supabase = getPublicClient();
    const { data: profile } = await supabase.rpc("get_profile_by_user_id", { uid: apiKeyUserId });

    return {
      userId: apiKeyUserId,
      selfNodeId: profile?.self_node_id ?? null,
    };
  }

  // Fall back to session auth
  const { getAuthContext } = await import("@/lib/auth");
  const auth = await getAuthContext();
  if (!auth) return null;
  return { userId: auth.userId, selfNodeId: auth.selfNodeId };
}
