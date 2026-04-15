import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { Dashboard } from "@/components/Dashboard";

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, self_node_id")
    .eq("id", user.id)
    .single();

  const displayName =
    profile?.display_name || user.user_metadata?.display_name || user.email?.split("@")[0] || "User";

  return (
    <Dashboard
      user={{
        id: user.id,
        email: user.email!,
        displayName,
        selfNodeId: profile?.self_node_id ?? null,
      }}
    />
  );
}
