import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { writeNeo4j } from "@/lib/neo4j";
import crypto from "crypto";

/**
 * Build a universal self-alias list from the display name + email. Runs at
 * /api/init time so any new user gets self-matching by name variants, email,
 * and common abbreviations without any per-user tuning.
 *
 * For "Sanchay Sachin Thalnerkar" + "sanchaythalnerkar@gmail.com":
 *   → ["Sanchay", "Sanchay T", "Sanchay Thalnerkar",
 *      "Sanchay Sachin", "Sanchay Sachin Thalnerkar",
 *      "sanchaythalnerkar@gmail.com"]
 */
function buildAliasList(displayName: string, email: string | null): string[] {
  const out = new Set<string>();
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return email ? [email.toLowerCase()] : [];

  const first = parts[0];
  const last = parts.length >= 2 ? parts[parts.length - 1] : null;

  out.add(displayName.trim()); // full name
  out.add(first); // first name alone

  // "First L" — first + last initial
  if (last) out.add(`${first} ${last[0]}`);
  // "First Last" — first + last skipping any middles
  if (last && parts.length >= 2) out.add(`${first} ${last}`);
  // Full-name permutation minus last token (drops the last part)
  if (parts.length >= 3) out.add(parts.slice(0, parts.length - 1).join(" "));

  if (email) out.add(email.toLowerCase());
  return Array.from(out);
}

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

  // Derive self-aliases from the display name + auth email so future ingests
  // can route self-references by name OR identifier without a Supabase round
  // trip. This is universal — works for any user, no hardcoded names.
  const aliases = buildAliasList(displayName, user.email ?? null);

  await writeNeo4j(
    user.id,
    `MERGE (p:Person {id: $selfNodeId, userId: $userId})
     ON CREATE SET p.name = $displayName, p.category = "self", p.relationship_score = 10,
                   p.email = $email, p.aliases = $aliases
     ON MATCH SET p.email = COALESCE(p.email, $email),
                  p.aliases = CASE
                    WHEN p.aliases IS NULL THEN $aliases
                    ELSE p.aliases + [a IN $aliases WHERE NOT a IN p.aliases]
                  END`,
    { selfNodeId, displayName, email: user.email ?? null, aliases }
  );

  // Update profile with self_node_id
  await supabase
    .from("profiles")
    .update({ self_node_id: selfNodeId })
    .eq("id", user.id);

  return NextResponse.json({ selfNodeId });
}
