import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { IntegrationsPage } from "@/components/IntegrationsPage";

export default async function SettingsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Latest active api key prefix — "cal_live_…<last 4>" is rendered
  // client-side. Full key is never persisted, only the sha-256 hash
  // via mint_api_key. If the user has no key yet, the UI offers to
  // generate one.
  const { data: keyRow } = await supabase
    .from("api_keys")
    .select("prefix")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return <IntegrationsPage apiKeyPrefix={keyRow?.prefix ?? null} />;
}
