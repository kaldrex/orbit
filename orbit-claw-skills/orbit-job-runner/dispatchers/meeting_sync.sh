#!/usr/bin/env bash
# Dispatcher: meeting_sync (hourly).
#
# Fires the orbit-meeting-brief SKILL headlessly via openclaw. The SKILL
# pulls upcoming events via orbit_calendar_fetch, synthesizes briefs via
# Haiku, and upserts via orbit_meeting_upsert.

set -u
PAYLOAD="$(cat)"

if ! command -v openclaw >/dev/null 2>&1; then
  jq -nc '{status:"failed", data:{error:"openclaw CLI not installed on host"}}'
  exit 0
fi

BRIEF="Phase 5 living-orbit tick: fetch upcoming calendar events (72h window), synthesize a short brief for each using Orbit context, and upsert via orbit_meeting_upsert. Skip events with no human attendees."

START=$(date +%s)
OUT="$(openclaw agent --agent main --json --timeout 1200 --message "Run the orbit-meeting-brief skill. Brief: ${BRIEF}" 2>&1 || true)"
END=$(date +%s)

if printf '%s' "${OUT}" | jq -e '.ok == true' >/dev/null 2>&1; then
  jq -nc --arg dur "$((END - START))" --argjson raw "${OUT}" \
    '{status:"succeeded", data:{duration_sec:($dur|tonumber), raw:$raw}}'
else
  jq -nc --arg dur "$((END - START))" --arg raw "${OUT}" \
    '{status:"failed", data:{duration_sec:($dur|tonumber), error:$raw}}'
fi
