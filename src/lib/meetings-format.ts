// Pure formatting helpers for the MeetingsStrip component.
//
// Kept Node-friendly (no JSX, no DOM) so vitest can run the unit tests
// without jsdom. The component imports these directly; tests hit them
// through module import.

export interface MeetingAttendee {
  email: string;
  name?: string;
  person_id?: string;
}

export interface Meeting {
  meeting_id: string;
  title: string | null;
  start_at: string; // ISO with offset
  end_at: string | null;
  attendees: MeetingAttendee[];
  brief_md: string | null;
  generated_at: string;
}

/**
 * Format a meeting start timestamp relative to `now`. Mirrors the
 * copy the dashboard wants: "in 3h", "in 45m", "tomorrow 10:00",
 * "Fri 14:30" — concise, human, no libraries.
 */
export function formatRelativeStart(
  startIso: string,
  now: Date = new Date(),
): string {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return startIso;

  const deltaMs = start.getTime() - now.getTime();
  if (deltaMs < 0) return "now";
  const deltaMinutes = Math.round(deltaMs / 60_000);
  if (deltaMinutes < 60) return `in ${Math.max(deltaMinutes, 1)}m`;

  const deltaHours = Math.round(deltaMs / (60 * 60_000));
  if (deltaHours < 24) return `in ${deltaHours}h`;

  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const hhmm = `${pad2(start.getHours())}:${pad2(start.getMinutes())}`;
  if (sameDay(start, tomorrow)) return `tomorrow ${hhmm}`;

  const weekday = start.toLocaleDateString("en-US", { weekday: "short" });
  return `${weekday} ${hhmm}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * Build a compact attendee-display list: prefer `name`, fall back to
 * the email local-part. De-dupes by `person_id` when present, else by
 * canonicalized email. Cap at 5 for the strip.
 */
export function formatAttendees(
  attendees: readonly MeetingAttendee[],
  cap = 5,
): Array<{ label: string; person_id?: string; email: string }> {
  const seen = new Set<string>();
  const out: Array<{ label: string; person_id?: string; email: string }> = [];
  for (const a of attendees) {
    const key = a.person_id ? `p:${a.person_id}` : `e:${a.email.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = a.name && a.name.trim()
      ? a.name.trim()
      : a.email.split("@")[0] || a.email;
    out.push({ label, person_id: a.person_id, email: a.email });
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Inline markdown token — emitted by parseInline so the component can
 * render as regular React elements (no raw HTML injection).
 */
export type InlineToken =
  | { kind: "text"; value: string }
  | { kind: "strong"; value: string }
  | { kind: "code"; value: string };

/**
 * Block-level brief element.
 */
export interface BriefBlock {
  kind: "paragraph" | "listItem";
  tokens: InlineToken[];
}

/**
 * Minimal markdown parser for brief_md. Supports:
 *  - paragraph separation on blank lines
 *  - unordered list (`- ` prefix)
 *  - bold (`**text**`)
 *  - inline code (`` `text` ``)
 *
 * Returns typed blocks + tokens so the caller renders via plain JSX —
 * no HTML injection.
 */
export function parseBriefMarkdown(src: string): BriefBlock[] {
  const trimmed = src.trim();
  if (!trimmed) return [];
  const blocks: BriefBlock[] = [];
  const paragraphs = trimmed.split(/\n\s*\n/);
  for (const para of paragraphs) {
    const lines = para.split("\n").map((l) => l.trimEnd());
    const isList = lines.every((l) => /^\s*-\s+/.test(l) || l.trim() === "");
    if (isList) {
      for (const l of lines) {
        const m = l.match(/^\s*-\s+(.*)$/);
        if (!m) continue;
        blocks.push({ kind: "listItem", tokens: parseInline(m[1]) });
      }
    } else {
      const text = lines.join(" ").replace(/\s+/g, " ").trim();
      if (text) blocks.push({ kind: "paragraph", tokens: parseInline(text) });
    }
  }
  return blocks;
}

function parseInline(raw: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  // Walk matches of **bold** or `code` in order of appearance.
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(raw)) !== null) {
    if (m.index > lastIndex) {
      tokens.push({ kind: "text", value: raw.slice(lastIndex, m.index) });
    }
    if (m[1] !== undefined) {
      tokens.push({ kind: "strong", value: m[1] });
    } else if (m[2] !== undefined) {
      tokens.push({ kind: "code", value: m[2] });
    }
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < raw.length) {
    tokens.push({ kind: "text", value: raw.slice(lastIndex) });
  }
  return tokens;
}

/**
 * True if the meeting has a non-empty synthesized brief.
 */
export function hasBrief(m: Meeting): boolean {
  return !!(m.brief_md && m.brief_md.trim().length > 0);
}
