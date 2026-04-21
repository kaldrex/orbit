#!/usr/bin/env bash
# Dispatcher: observer.
#
# Reads a JSON payload {since?: ISO8601} from stdin. For V0 we don't
# actually need the 'since' cursor — the openclaw observer SKILL scans
# wacli + gmail and emits observations via orbit_observation_emit,
# which dedupes server-side on evidence_pointer. The 'since' is passed
# along as context so the SKILL can prioritize recent threads.
#
# FIRST-RUN DETECTION: before dispatching to orbit-observer, we check
# whether this founder's observation basket is empty. If it is, we
# first invoke the orbit-observer-backfill SKILL which seeds raw_events
# + lid_bridge + interactions from the local wacli snapshot via the
# orbit-cli verbs (no Anthropic key, no direct DB). Once backfill is
# done, the normal observer run proceeds.
#
# Output (stdout): {"status":"succeeded"|"failed","data":{...}}
#
# This wrapper is a thin harness; it invokes the openclaw CLI in
# headless mode with the orbit-observer (and optionally backfill) SKILL.
# If openclaw is not available on the host (dev machine), we emit
# status:"failed" with a reason so the job is flagged.

set -u
PAYLOAD="$(cat)"
SINCE="$(printf '%s' "${PAYLOAD}" | jq -r '.since // empty')"

if ! command -v openclaw >/dev/null 2>&1; then
  jq -nc --arg reason "openclaw CLI not installed on host" \
    '{status:"failed", data:{error:$reason}}'
  exit 0
fi

# --- First-run detection ---------------------------------------------
# Hit /api/v1/observations?limit=1. Empty basket → this is a new founder
# who needs backfill before the observer can do anything useful. We use
# curl directly here (not orbit-cli) because this wrapper is pre-SKILL
# plumbing and must stay side-effect-free until it decides to dispatch.
FIRST_RUN="false"
if [[ -n "${ORBIT_API_URL:-}" && -n "${ORBIT_API_KEY:-}" ]]; then
  BASE_URL="${ORBIT_API_URL%/}"
  OBS_PROBE="$(curl -sS --max-time 10 \
    -H "Authorization: Bearer ${ORBIT_API_KEY}" \
    "${BASE_URL}/observations?limit=1" 2>/dev/null || echo '{}')"
  OBS_COUNT="$(printf '%s' "${OBS_PROBE}" | jq -r '.observations | length // 0' 2>/dev/null || echo 0)"
  if [[ "${OBS_COUNT}" == "0" ]]; then
    FIRST_RUN="true"
  fi
fi

START=$(date +%s)
BACKFILL_RAW=""

# --- Backfill (first run only) ---------------------------------------
if [[ "${FIRST_RUN}" == "true" ]]; then
  BACKFILL_BRIEF="First-run backfill tick. The observation basket is empty — seed raw_events, lid_bridge, and interactions from ~/.wacli/wacli.db + ~/.wacli/session.db via the orbit-cli onboarding verbs. Run the three verbs in order (orbit_raw_events_backfill_from_wacli → orbit_lid_bridge_ingest → orbit_interactions_backfill) and print the final backfill log line. No Anthropic calls — pure plumbing."
  BACKFILL_RAW="$(openclaw agent --agent main --json --timeout 1800 --message "Run the orbit-observer-backfill skill. Brief: ${BACKFILL_BRIEF}" 2>&1 || true)"
  # If backfill failed hard, skip the observer run and report the
  # failure — a partial basket would mislead the observer anyway.
  if ! printf '%s' "${BACKFILL_RAW}" | jq -e '.ok == true' >/dev/null 2>&1; then
    END=$(date +%s)
    jq -nc --arg dur "$((END - START))" --arg raw "${BACKFILL_RAW}" \
      '{status:"failed", data:{duration_sec:($dur|tonumber), stage:"backfill", error:$raw}}'
    exit 0
  fi
fi

# --- Observer run (always) -------------------------------------------
BRIEF="Phase 5 living-orbit tick. Scan WhatsApp + Gmail for any human with activity since ${SINCE:-epoch}. Emit person + interaction observations via orbit_observation_emit. Do not re-enrich Umayr (67050b91-5011-4ba6-b230-9a387879717a) — he is the canary."

OUT="$(openclaw agent --agent main --json --timeout 1200 --message "Run the orbit-observer skill. Brief: ${BRIEF}" 2>&1 || true)"
END=$(date +%s)

if printf '%s' "${OUT}" | jq -e '.ok == true' >/dev/null 2>&1; then
  if [[ -n "${BACKFILL_RAW}" ]]; then
    jq -nc --arg dur "$((END - START))" --argjson raw "${OUT}" --argjson bf "${BACKFILL_RAW}" \
      '{status:"succeeded", data:{duration_sec:($dur|tonumber), first_run:true, backfill:$bf, raw:$raw}}'
  else
    jq -nc --arg dur "$((END - START))" --argjson raw "${OUT}" \
      '{status:"succeeded", data:{duration_sec:($dur|tonumber), raw:$raw}}'
  fi
else
  jq -nc --arg dur "$((END - START))" --arg raw "${OUT}" \
    '{status:"failed", data:{duration_sec:($dur|tonumber), error:$raw}}'
fi
