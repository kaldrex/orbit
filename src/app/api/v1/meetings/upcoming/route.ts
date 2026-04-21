import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getAgentOrSessionAuth } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const DEFAULT_HORIZON_HOURS = 72;
const MAX_HORIZON_HOURS = 24 * 30; // one month — guardrail, not a product cap.

const attendeeSchema = z.object({
  email: z.string().trim().min(1).max(256),
  name: z.string().trim().max(256).optional(),
  person_id: z.string().uuid().optional(),
});

const meetingSchema = z.object({
  meeting_id: z.string().trim().min(1).max(256),
  title: z.string().trim().max(512).nullable().optional(),
  start_at: z.string().datetime({ offset: true }),
  end_at: z.string().datetime({ offset: true }).nullable().optional(),
  attendees: z.array(attendeeSchema).max(100).default([]),
  brief_md: z.string().max(8000).nullable().optional(),
});

const postBodySchema = z.object({
  meetings: z.array(meetingSchema).min(1).max(100),
});

interface UpcomingRow {
  meeting_id: string;
  title: string | null;
  start_at: string;
  end_at: string | null;
  attendees_json: unknown;
  brief_md: string | null;
  generated_at: string;
}

interface AttendeeOut {
  email: string;
  name?: string;
  person_id?: string;
}

/**
 * GET /api/v1/meetings/upcoming
 *
 * Session-or-Bearer. Returns the caller's meetings starting within
 * [NOW(), NOW() + horizon_hours), ordered by start_at ASC. Backed by
 * select_upcoming_meetings SECURITY DEFINER RPC (same pattern as
 * select_enriched_persons, select_capability_reports).
 *
 * Query params:
 *   horizon_hours — optional, default 72, clamped to [1, 720].
 *
 * Response: { meetings: MeetingOut[] }
 */
export async function GET(request: Request) {
  const auth = await getAgentOrSessionAuth(request);
  if (!auth) {
    return NextResponse.json(
      {
        error: {
          code: "unauthorized",
          message: "Sign in or send a valid API key to read meetings.",
        },
      },
      { status: 401 },
    );
  }

  const url = new URL(request.url);
  const rawHorizon = url.searchParams.get("horizon_hours");
  let horizonHours = DEFAULT_HORIZON_HOURS;
  if (rawHorizon !== null) {
    const n = parseInt(rawHorizon, 10);
    if (!Number.isFinite(n) || n <= 0) {
      return NextResponse.json(
        {
          error: {
            code: "invalid_horizon",
            message: "horizon_hours must be a positive integer.",
          },
        },
        { status: 400 },
      );
    }
    horizonHours = Math.min(n, MAX_HORIZON_HOURS);
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim(),
  );

  const { data, error } = await supabase.rpc("select_upcoming_meetings", {
    p_user_id: auth.userId,
    p_horizon_hours: horizonHours,
  });

  if (error) {
    console.error("[meetings/upcoming] rpc error", error);
    return NextResponse.json(
      {
        error: {
          code: "read_failed",
          message: "Could not load upcoming meetings.",
        },
      },
      { status: 502 },
    );
  }

  const rows = (Array.isArray(data) ? data : []) as UpcomingRow[];
  const meetings = rows.map((r) => ({
    meeting_id: r.meeting_id,
    title: r.title ?? "",
    start_at: r.start_at,
    end_at: r.end_at,
    attendees: normalizeAttendees(r.attendees_json),
    brief_md: r.brief_md,
    generated_at: r.generated_at,
  }));

  return NextResponse.json({ meetings });
}

/**
 * POST /api/v1/meetings/upcoming
 *
 * Bearer-or-session. Upserts a batch of meetings via upsert_meeting
 * RPC (one call per row — small batches, simple contract, no
 * transactional pool).
 *
 * Body: { meetings: [{ meeting_id, title?, start_at, end_at?, attendees[], brief_md? }] }
 * Response: { upserted: N }
 */
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

  const parsed = postBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "invalid_body",
          message: "Body failed schema validation.",
          suggestion:
            "Send { meetings: [{ meeting_id, title?, start_at, end_at?, attendees: [{email, name?}], brief_md? }] }.",
        },
      },
      { status: 400 },
    );
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim(),
  );

  let upserted = 0;
  for (const m of parsed.data.meetings) {
    const { error } = await supabase.rpc("upsert_meeting", {
      p_user_id: auth.userId,
      p_meeting_id: m.meeting_id,
      p_title: m.title ?? null,
      p_start_at: m.start_at,
      p_end_at: m.end_at ?? null,
      p_attendees_json: m.attendees,
      p_brief_md: m.brief_md ?? null,
    });
    if (error) {
      console.error(
        "[meetings/upcoming] upsert_meeting failed",
        { meeting_id: m.meeting_id, error },
      );
      return NextResponse.json(
        {
          error: {
            code: "write_failed",
            message: "Could not persist meetings.",
            meeting_id: m.meeting_id,
            upserted_before_failure: upserted,
          },
        },
        { status: 502 },
      );
    }
    upserted += 1;
  }

  return NextResponse.json({ upserted });
}

function normalizeAttendees(raw: unknown): AttendeeOut[] {
  if (!Array.isArray(raw)) return [];
  const out: AttendeeOut[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const email = typeof rec.email === "string" ? rec.email : null;
    if (!email) continue;
    const entry: AttendeeOut = { email };
    if (typeof rec.name === "string" && rec.name.trim()) entry.name = rec.name;
    if (typeof rec.person_id === "string" && rec.person_id)
      entry.person_id = rec.person_id;
    out.push(entry);
  }
  return out;
}
