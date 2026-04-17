import { createHash, randomBytes } from "crypto";
import { createClient } from "@supabase/supabase-js";

function getPublicClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim()
  );
}

export async function generateApiKey(userId: string, name: string) {
  const raw = `orb_live_${randomBytes(24).toString("base64url")}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  const prefix = raw.slice(0, 12);
  return { key: raw, hash, prefix, name };
}

// In-memory rate limiter for API key validation (per serverless instance)
const failedAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_FAILURES = 10;
const WINDOW_MS = 60_000; // 1 minute

function isRateLimited(identifier: string): boolean {
  const now = Date.now();
  const entry = failedAttempts.get(identifier);
  if (!entry || now > entry.resetAt) return false;
  return entry.count >= MAX_FAILURES;
}

function recordFailedAttempt(identifier: string): void {
  const now = Date.now();
  const entry = failedAttempts.get(identifier);
  if (!entry || now > entry.resetAt) {
    failedAttempts.set(identifier, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    entry.count++;
  }
}

export async function validateApiKey(authHeader: string | null, clientIp?: string): Promise<string | null> {
  if (!authHeader) return null;

  const key = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
  if (!key.startsWith("orb_live_")) return null;

  // Rate limit by key prefix (first 12 chars) + IP
  const rateLimitKey = `${key.slice(0, 12)}:${clientIp || "unknown"}`;
  if (isRateLimited(rateLimitKey)) {
    return null; // Silently reject — don't reveal rate limiting
  }

  const hash = createHash("sha256").update(key).digest("hex");
  const supabase = getPublicClient();

  const { data: userId } = await supabase.rpc("validate_api_key", { key_hash_input: hash });
  if (!userId) {
    recordFailedAttempt(rateLimitKey);
    return null;
  }

  return userId as string;
}

export async function getAgentOrSessionAuth(request: Request): Promise<{
  userId: string;
  selfNodeId: string | null;
  displayName?: string;
  authEmail?: string;
} | null> {
  // Try API key first
  const authHeader = request.headers.get("authorization");
  const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || undefined;
  const apiKeyUserId = await validateApiKey(authHeader, clientIp);

  if (apiKeyUserId) {
    const supabase = getPublicClient();
    const { data: profile } = await supabase.rpc("get_profile_by_user_id", { uid: apiKeyUserId });

    return {
      userId: apiKeyUserId,
      selfNodeId: profile?.self_node_id ?? null,
      displayName: profile?.display_name ?? undefined,
      authEmail: profile?.email ?? undefined,
    };
  }

  // Fall back to session auth
  const { getAuthContext } = await import("@/lib/auth");
  const auth = await getAuthContext();
  if (!auth) return null;
  return {
    userId: auth.userId,
    selfNodeId: auth.selfNodeId,
    displayName: auth.displayName,
    authEmail: auth.authEmail ?? undefined,
  };
}
