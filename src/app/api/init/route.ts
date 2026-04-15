import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { writeNeo4j } from "@/lib/neo4j";
import crypto from "crypto";

/**
 * POST /api/init
 * Called on first dashboard load. Creates the user's self-node in Neo4j
 * if it doesn't exist yet, and updates the Supabase profile.
 */
export async function POST() {
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

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Check if profile already has a self_node_id
  const { data: profile } = await supabase
    .from("profiles")
    .select("self_node_id, display_name")
    .eq("id", user.id)
    .single();

  if (profile?.self_node_id) {
    return NextResponse.json({ selfNodeId: profile.self_node_id });
  }

  // Create self-node in Neo4j
  const selfNodeId = `user_${crypto.randomUUID().slice(0, 8)}`;
  const displayName =
    profile?.display_name ||
    user.user_metadata?.display_name ||
    user.email?.split("@")[0] ||
    "You";

  await writeNeo4j(
    user.id,
    `CREATE (p:Person {
      id: $selfNodeId,
      userId: $userId,
      name: $displayName,
      category: "self",
      relationship_score: 10
    })`,
    { selfNodeId, displayName }
  );

  // Update profile with self_node_id
  await supabase
    .from("profiles")
    .update({ self_node_id: selfNodeId })
    .eq("id", user.id);

  return NextResponse.json({ selfNodeId });
}
