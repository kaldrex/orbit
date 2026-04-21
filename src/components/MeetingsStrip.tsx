"use client";

import { useEffect, useMemo, useState, type ReactElement } from "react";
import {
  formatAttendees,
  formatRelativeStart,
  hasBrief,
  parseBriefMarkdown,
  type InlineToken,
  type Meeting,
} from "@/lib/meetings-format";

interface MeetingsStripProps {
  isDark: boolean;
  onSelectPerson?: (personId: string) => void;
  /**
   * Hours into the future to display. Defaults to 48h for the strip;
   * the backend defaults to 72h. We ask for 48 to keep the strip
   * tight but the POST path supports arbitrary horizons.
   */
  horizonHours?: number;
}

interface ApiResponse {
  meetings?: Meeting[];
  error?: { code?: string; message?: string };
}

/**
 * Upcoming-meetings strip rendered above the filter pills on the
 * dashboard. Pulls `/api/v1/meetings/upcoming?horizon_hours=…` under
 * session auth, shows one row per meeting with title, relative start,
 * clickable attendees, and an expandable brief when present.
 *
 * Renders nothing when the API returns zero meetings — no empty state,
 * no scaffolding.
 */
export default function MeetingsStrip({
  isDark,
  onSelectPerson,
  horizonHours = 48,
}: MeetingsStripProps) {
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    const url = `/api/v1/meetings/upcoming?horizon_hours=${encodeURIComponent(
      String(horizonHours),
    )}`;
    fetch(url, { credentials: "include" })
      .then((r) => (r.ok ? (r.json() as Promise<ApiResponse>) : null))
      .then((body) => {
        if (cancelled) return;
        setMeetings(body?.meetings ?? []);
      })
      .catch(() => {
        if (!cancelled) setMeetings([]);
      });
    return () => {
      cancelled = true;
    };
  }, [horizonHours]);

  // Recompute the relative-start labels on a gentle cadence so "in 3h"
  // doesn't go stale while the dashboard sits open. Once per minute is
  // plenty — no sub-minute granularity in the strings.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const now = useMemo(() => new Date(nowTick), [nowTick]);

  if (meetings === null) return null;
  if (meetings.length === 0) return null;

  const borderCls = isDark
    ? "border-zinc-800/40 bg-zinc-950/50"
    : "border-zinc-200 bg-white";
  const titleCls = isDark ? "text-zinc-100" : "text-zinc-900";
  const metaCls = isDark ? "text-zinc-500" : "text-zinc-500";
  const linkCls = isDark
    ? "text-zinc-300 hover:text-white hover:underline"
    : "text-zinc-700 hover:text-zinc-900 hover:underline";
  const briefToggleCls = isDark
    ? "text-zinc-400 hover:text-zinc-200"
    : "text-zinc-500 hover:text-zinc-800";
  const briefBodyCls = isDark ? "text-zinc-300" : "text-zinc-700";

  return (
    <section
      data-testid="meetings-strip"
      className={`w-full border-b px-4 py-2 ${borderCls}`}
      aria-label="Upcoming meetings"
    >
      <div className="flex items-start gap-6 overflow-x-auto">
        {meetings.map((m) => {
          const attendees = formatAttendees(m.attendees);
          const isOpen = !!expanded[m.meeting_id];
          const briefVisible = hasBrief(m);
          return (
            <div
              key={m.meeting_id}
              className="min-w-[240px] max-w-[420px] flex flex-col gap-1"
            >
              <div className="flex items-baseline gap-2">
                <span className={`text-[13px] font-semibold ${titleCls}`}>
                  {m.title || "Untitled meeting"}
                </span>
                <span className={`text-[11px] ${metaCls}`}>
                  {formatRelativeStart(m.start_at, now)}
                </span>
              </div>

              {attendees.length > 0 && (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
                  {attendees.map((a, idx) => (
                    <span key={`${a.email}-${idx}`}>
                      {a.person_id && onSelectPerson ? (
                        <button
                          type="button"
                          onClick={() => onSelectPerson(a.person_id!)}
                          className={linkCls}
                        >
                          {a.label}
                        </button>
                      ) : (
                        <span className={metaCls}>{a.label}</span>
                      )}
                      {idx < attendees.length - 1 && (
                        <span className={metaCls}>,</span>
                      )}
                    </span>
                  ))}
                </div>
              )}

              {briefVisible && (
                <div className="flex flex-col gap-1">
                  <button
                    type="button"
                    onClick={() =>
                      setExpanded((prev) => ({
                        ...prev,
                        [m.meeting_id]: !prev[m.meeting_id],
                      }))
                    }
                    className={`text-left text-[11px] ${briefToggleCls}`}
                    aria-expanded={isOpen}
                  >
                    {isOpen ? "Hide brief" : "Show brief"}
                  </button>
                  {isOpen && (
                    <div
                      className={`text-[12px] leading-relaxed ${briefBodyCls}`}
                      data-testid={`brief-${m.meeting_id}`}
                    >
                      {renderBrief(m.brief_md ?? "")}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function renderBrief(src: string) {
  const blocks = parseBriefMarkdown(src);
  const paragraphs: ReactElement[] = [];
  let listBuffer: ReactElement[] = [];
  let key = 0;

  const flushList = () => {
    if (listBuffer.length === 0) return;
    paragraphs.push(
      <ul key={`ul-${key++}`} className="list-disc pl-5 space-y-0.5">
        {listBuffer}
      </ul>,
    );
    listBuffer = [];
  };

  for (const b of blocks) {
    if (b.kind === "listItem") {
      listBuffer.push(
        <li key={`li-${key++}`}>{renderTokens(b.tokens)}</li>,
      );
    } else {
      flushList();
      paragraphs.push(
        <p key={`p-${key++}`} className="mt-1 first:mt-0">
          {renderTokens(b.tokens)}
        </p>,
      );
    }
  }
  flushList();
  return paragraphs;
}

function renderTokens(tokens: readonly InlineToken[]) {
  return tokens.map((t, i) => {
    if (t.kind === "strong") return <strong key={i}>{t.value}</strong>;
    if (t.kind === "code")
      return (
        <code
          key={i}
          className="rounded bg-zinc-800/50 px-1 py-0.5 text-[11px]"
        >
          {t.value}
        </code>
      );
    return <span key={i}>{t.value}</span>;
  });
}
