import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Extract authenticated user + their self_node_id from the session.
 * Used by all protected API routes.
 */
export async function getAuthContext(): Promise<{
  userId: string;
  selfNodeId: string | null;
  displayName: string;
} | null> {
  const cookieStore = await cookies();
  const supabase = createServerClient(
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

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("self_node_id, display_name")
    .eq("id", user.id)
    .single();

  return {
    userId: user.id,
    selfNodeId: profile?.self_node_id ?? null,
    displayName:
      profile?.display_name ??
      user.user_metadata?.display_name ??
      user.email?.split("@")[0] ??
      "User",
  };
}
