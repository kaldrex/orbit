import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAgentOrSessionAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export async function GET(request: Request) {
  const auth = await getAgentOrSessionAuth(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const phone = url.searchParams.get("phone");
  const email = url.searchParams.get("email");
  const name = url.searchParams.get("name");
  const provided = [phone, email, name].filter((v) => v && v.trim().length > 0);
  if (provided.length !== 1) {
    return NextResponse.json(
      { error: "provide exactly one of phone, email, or name" },
      { status: 400 },
    );
  }

  let limit = DEFAULT_LIMIT;
  const rawLimit = url.searchParams.get("limit");
  if (rawLimit) {
    const n = parseInt(rawLimit, 10);
    if (!Number.isFinite(n) || n <= 0) {
      return NextResponse.json({ error: "invalid limit" }, { status: 400 });
    }
    limit = Math.min(n, MAX_LIMIT);
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim(),
  );
  const { data, error } = await supabase.rpc("search_persons", {
    p_user_id: auth.userId,
    p_phone: phone?.trim() || null,
    p_email: email?.trim().toLowerCase() || null,
    p_name: name?.trim() || null,
    p_limit: limit,
  });
  if (error) {
    console.error("[persons/search] rpc error", error);
    return NextResponse.json({ error: "read failed" }, { status: 502 });
  }

  const persons = Array.isArray(data) ? data : [];
  return NextResponse.json({ persons, total: persons.length });
}
