import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAgentOrSessionAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// POST /api/v1/lid_bridge/upsert
//
// Bearer-or-session auth. Bulk-upserts entries of {lid, phone, last_seen?}
// into the lid_phone_bridge projection. LID → phone map is copied from
// claw's ~/.wacli/session.db (whatsmeow_lid_map) so the graph populate
// pipeline can resolve @lid-only group senders back to persons.
//
// The bridge is a projection (not an observation-kind): it's a lookup
// table the populate RPCs consult — not a statement about who someone is.
// Writes go through the API (per house rule "API is the only writer"),
// but nothing here touches observations.
// ---------------------------------------------------------------------------

const MAX_BATCH = 1000;

const entrySchema = z.object({
  lid: z.string().trim().min(1).max(64),
  phone: z.string().trim().min(1).max(32),
  last_seen: z.string().datetime({ offset: true }).optional(),
});

const bodySchema = z.object({
  entries: z.array(entrySchema).min(1).max(MAX_BATCH),
});

export async function POST(request: Request) {
  const auth = await getAgentOrSessionAuth(request);
  if (!auth) {
    return NextResponse.json(
      {
        error: {
          code: "unauthorized",
          message: "Valid API key or session required.",
        },
      },
      { status: 401 },
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
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
    return NextResponse.json(
      {
        error: {
          code: "invalid_body",
          message: "Body failed schema validation.",
          suggestion:
            "Send { entries: [{ lid: '<digits>', phone: '<digits>', last_seen?: '<ISO>' }] } — max 1000 entries per call.",
        },
      },
      { status: 400 },
    );
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim(),
  );

  const { data, error } = await supabase.rpc("upsert_lid_bridge", {
    p_user_id: auth.userId,
    p_entries: parsed.data.entries,
  });

  if (error) {
    console.error("[lid_bridge/upsert] rpc error", error);
    return NextResponse.json(
      {
        error: {
          code: "write_failed",
          message: "Could not persist LID bridge entries.",
        },
      },
      { status: 502 },
    );
  }

  const upserted = typeof data === "number" ? data : parsed.data.entries.length;
  return NextResponse.json({ upserted });
}
