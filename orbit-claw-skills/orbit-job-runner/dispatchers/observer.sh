#!/usr/bin/env bash
# Dispatcher: observer.
#
# Reads a JSON payload {since?: ISO8601} from stdin. For V0 we don't
# actually need the 'since' cursor — the openclaw observer SKILL scans
# wacli + gmail and emits observations via orbit_observation_emit,
# which dedupes server-side on evidence_pointer. The 'since' is passed
# along as context so the SKILL can prioritize recent threads.
#
# Output (stdout): {"status":"succeeded"|"failed","data":{...}}
#
# This wrapper is a thin harness; it invokes the openclaw CLI in
# headless mode with the orbit-observer SKILL. If openclaw is not
# available on the host (dev machine), we emit status:"failed" with
# a reason so the job is flagged and the cron keeps running.

set -u
PAYLOAD="$(cat)"
SINCE="$(printf '%s' "${PAYLOAD}" | jq -r '.since // empty')"

if ! command -v openclaw >/dev/null 2>&1; then
  jq -nc --arg reason "openclaw CLI not installed on host" \
    '{status:"failed", data:{error:$reason}}'
  exit 0
fi

# Fire the observer SKILL with a scan brief. The SKILL uses orbit-cli
# tools (orbit_observation_emit) to write back — never direct DB.
BRIEF="Phase 5 living-orbit tick. Scan WhatsApp + Gmail for any human with activity since ${SINCE:-epoch}. Emit person + interaction observations via orbit_observation_emit. Do not re-enrich Umayr (67050b91-5011-4ba6-b230-9a387879717a) — he is the canary."

START=$(date +%s)
OUT="$(openclaw run --skill orbit-observer --prompt "${BRIEF}" --json 2>&1 || true)"
END=$(date +%s)

if printf '%s' "${OUT}" | jq -e '.ok == true' >/dev/null 2>&1; then
  jq -nc --arg dur "$((END - START))" --argjson raw "${OUT}" \
    '{status:"succeeded", data:{duration_sec:($dur|tonumber), raw:$raw}}'
else
  jq -nc --arg dur "$((END - START))" --arg raw "${OUT}" \
    '{status:"failed", data:{duration_sec:($dur|tonumber), error:$raw}}'
fi
