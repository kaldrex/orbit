#!/usr/bin/env bash
# orbit-job-runner / run-once.sh
#
# Phase 5 — Living Orbit. One tick of the claw-side job runner:
#
#   1. POST /api/v1/jobs/claim with the kinds this agent can dispatch.
#   2. If the queue is empty (job=null), log and exit 0.
#   3. Otherwise, shell out to the matching dispatcher for the job.kind
#      (observer, enricher, meeting_sync, topic_resonance).
#   4. POST /api/v1/jobs/report with the dispatcher's exit status.
#
# Installed via systemd.timer (see orbit-job-runner.timer / .service in
# this directory) on a 15-minute cadence. Never retries in-script —
# a failed run logs and exits; the next timer tick is the retry.
#
# Env (read from /home/sanchay/.orbit/env — symlinked / sourced by the
# systemd unit):
#   ORBIT_API_BASE      bare host, NO /api/v1 suffix
#                       (e.g. http://100.97.152.84:3047 or https://orbit.example.com)
#   ORBIT_API_KEY       Bearer token (orb_live_...)
#   ANTHROPIC_API_KEY   for the enricher / topic-resonance SKILLs
#
# Exit codes:
#   0  ok (job dispatched + reported, or queue empty)
#   1  fatal — env misconfigured, curl failure, etc. (systemd restarts on next tick)

set -u  # unset vars are errors, but we don't set -e — we want to
        # continue past dispatcher failures and report them back.

AGENT_ID="${ORBIT_AGENT_ID:-wazowski}"
KINDS_JSON='["observer","enricher","meeting_sync","topic_resonance"]'
LOG_DIR="${ORBIT_JOB_RUNNER_LOG_DIR:-/home/sanchay/orbit-enrichment-logs/job-runner}"
TICK_TAG="$(date -u +%Y%m%dT%H%M%SZ)"
TICK_LOG="${LOG_DIR}/tick-${TICK_TAG}.log"

mkdir -p "${LOG_DIR}"

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "${TICK_LOG}" >&2
}

if [[ -z "${ORBIT_API_BASE:-}" || -z "${ORBIT_API_KEY:-}" ]]; then
  log "FATAL: ORBIT_API_BASE / ORBIT_API_KEY must be set"
  exit 1
fi

# ORBIT_API_BASE is the bare host (no /api/v1). The script appends
# /api/v1/<route> at every call site so the invariant is visible.
API_BASE="${ORBIT_API_BASE%/}"

if [[ "${API_BASE}" == *"/api/v"* ]]; then
  log "FATAL: ORBIT_API_BASE must not contain /api/v<N> — got ${API_BASE}"
  exit 1
fi

log "tick start agent=${AGENT_ID} kinds=${KINDS_JSON}"

# --- 1. Claim a job ----------------------------------------------------
CLAIM_BODY="$(printf '{"agent":"%s","kinds":%s}' "${AGENT_ID}" "${KINDS_JSON}")"
CLAIM_RESP="$(curl -sS -X POST "${API_BASE}/api/v1/jobs/claim" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${ORBIT_API_KEY}" \
  --data "${CLAIM_BODY}" || true)"

if [[ -z "${CLAIM_RESP}" ]]; then
  log "FATAL: empty response from /jobs/claim"
  exit 1
fi

JOB_ID="$(printf '%s' "${CLAIM_RESP}" | jq -r '.job.id // empty')"
JOB_KIND="$(printf '%s' "${CLAIM_RESP}" | jq -r '.job.kind // empty')"
JOB_PAYLOAD="$(printf '%s' "${CLAIM_RESP}" | jq -c '.job.payload // {}')"

if [[ -z "${JOB_ID}" ]]; then
  log "queue empty — exiting"
  exit 0
fi

log "claimed job id=${JOB_ID} kind=${JOB_KIND}"

# --- 2. Dispatch to the matching SKILL wrapper ------------------------
#
# Each dispatcher is a small wrapper script that:
#   - reads the payload from stdin (JSON),
#   - does the work (calls openclaw / orbit-cli / LLM as needed),
#   - prints a JSON {status, data} envelope to stdout.
#
# If a dispatcher is missing, we report status:"failed" with a
# 'dispatcher_missing' error so the job doesn't spin.

DISPATCHERS_DIR="$(dirname "$0")/dispatchers"
DISPATCHER="${DISPATCHERS_DIR}/${JOB_KIND}.sh"

STATUS="failed"
RESULT_JSON='{"error":"dispatcher_missing"}'

if [[ -x "${DISPATCHER}" ]]; then
  log "dispatching → ${DISPATCHER}"
  DISPATCH_OUT="$(printf '%s' "${JOB_PAYLOAD}" | "${DISPATCHER}" 2>>"${TICK_LOG}" || true)"
  if [[ -z "${DISPATCH_OUT}" ]]; then
    STATUS="failed"
    RESULT_JSON='{"error":"dispatcher_empty_output"}'
  else
    # Dispatcher output must be a JSON {status, data} envelope.
    DISPATCH_STATUS="$(printf '%s' "${DISPATCH_OUT}" | jq -r '.status // "failed"' 2>/dev/null || echo failed)"
    case "${DISPATCH_STATUS}" in
      succeeded|failed|retry) STATUS="${DISPATCH_STATUS}" ;;
      *) STATUS="failed" ;;
    esac
    RESULT_JSON="$(printf '%s' "${DISPATCH_OUT}" | jq -c '.data // {}' 2>/dev/null || echo '{}')"
  fi
else
  log "WARN: no dispatcher at ${DISPATCHER} — reporting failure"
fi

# --- 3. Report the outcome --------------------------------------------
REPORT_BODY="$(jq -nc \
  --arg job_id "${JOB_ID}" \
  --arg status "${STATUS}" \
  --argjson result "${RESULT_JSON}" \
  '{job_id:$job_id, status:$status, result:$result}')"

REPORT_RESP="$(curl -sS -X POST "${API_BASE}/api/v1/jobs/report" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${ORBIT_API_KEY}" \
  --data "${REPORT_BODY}" || true)"

log "reported job=${JOB_ID} status=${STATUS} response=${REPORT_RESP}"
log "tick done"
exit 0
