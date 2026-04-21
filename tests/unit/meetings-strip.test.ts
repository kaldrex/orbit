import { describe, it, expect } from "vitest";
import {
  formatAttendees,
  formatRelativeStart,
  hasBrief,
  parseBriefMarkdown,
  type Meeting,
} from "../../src/lib/meetings-format";

/**
 * MeetingsStrip is a thin client component — its behavior lives in
 * the pure helpers in src/lib/meetings-format.ts (no jsdom in this
 * repo). These tests pin the two render states the strip cares
 * about:
 *   1) a meeting with a brief (renders clickable toggle + parsed body)
 *   2) a meeting without a brief (renders title + attendees only)
 * Plus attendee + relative-start formatting, which drive the visible
 * copy in both cases.
 */

function makeMeeting(partial: Partial<Meeting>): Meeting {
  return {
    meeting_id: partial.meeting_id ?? "evt-1",
    title: partial.title ?? "Founder sync",
    start_at: partial.start_at ?? "2026-04-22T09:00:00+00:00",
    end_at: partial.end_at ?? null,
    attendees: partial.attendees ?? [],
    brief_md: partial.brief_md ?? null,
    generated_at: partial.generated_at ?? "2026-04-21T10:00:00+00:00",
  };
}

describe("MeetingsStrip — with brief", () => {
  it("renders attendees, relative start, and parsed brief blocks", () => {
    const m = makeMeeting({
      title: "Umayr 1:1",
      start_at: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      attendees: [
        { email: "usheik@sinx.ai", name: "Umayr Sheik", person_id: "umayr-id" },
        { email: "sanchay@localhost.ai" },
      ],
      brief_md:
        "**Shared history:** Sinx fundraise chats in March.\n\n- Ask about runway.\n- Raise the `hiring` plan.",
    });

    expect(hasBrief(m)).toBe(true);

    const attendees = formatAttendees(m.attendees);
    expect(attendees).toHaveLength(2);
    expect(attendees[0]).toEqual({
      label: "Umayr Sheik",
      person_id: "umayr-id",
      email: "usheik@sinx.ai",
    });
    // Email-only attendee falls back to local-part as display.
    expect(attendees[1].label).toBe("sanchay");

    const relative = formatRelativeStart(m.start_at);
    expect(relative).toMatch(/^in \d+h$/);

    const blocks = parseBriefMarkdown(m.brief_md!);
    // Paragraph first (with bolded "Shared history:"), then 2 list items.
    expect(blocks).toHaveLength(3);
    expect(blocks[0].kind).toBe("paragraph");
    expect(blocks[0].tokens.find((t) => t.kind === "strong")?.value).toBe(
      "Shared history:",
    );
    expect(blocks[1].kind).toBe("listItem");
    expect(blocks[2].kind).toBe("listItem");
    // Inline code token on the second list item.
    expect(blocks[2].tokens.find((t) => t.kind === "code")?.value).toBe(
      "hiring",
    );
  });
});

describe("MeetingsStrip — without brief", () => {
  it("renders title + attendees only; brief section is suppressed", () => {
    const m = makeMeeting({
      title: "Investor update",
      start_at: new Date(Date.now() + 45 * 60_000).toISOString(),
      attendees: [
        { email: "eli@fund.vc", name: "Eli M" },
        { email: "eli@fund.vc", name: "Eli M" }, // duplicate, dedup
      ],
      brief_md: null,
    });

    expect(hasBrief(m)).toBe(false);
    expect(parseBriefMarkdown(m.brief_md ?? "")).toEqual([]);

    const attendees = formatAttendees(m.attendees);
    expect(attendees).toHaveLength(1); // dedup by canonical email
    expect(attendees[0].label).toBe("Eli M");

    const relative = formatRelativeStart(m.start_at);
    expect(relative).toMatch(/^in \d+m$/);
  });

  it("empty attendees + empty brief collapse to a minimal row", () => {
    const m = makeMeeting({
      title: null,
      attendees: [],
      brief_md: "   \n\n  ",
    });
    // Whitespace-only brief is treated as no brief — the toggle
    // is suppressed and parseBriefMarkdown returns zero blocks.
    expect(hasBrief(m)).toBe(false);
    expect(parseBriefMarkdown(m.brief_md ?? "")).toEqual([]);
    expect(formatAttendees(m.attendees)).toEqual([]);
  });
});
