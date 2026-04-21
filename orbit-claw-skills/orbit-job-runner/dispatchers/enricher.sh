#!/usr/bin/env bash
# Dispatcher: enricher (14-day cadence).
#
# Reads payload {persons: [uuid,...]} from stdin. Shells out to the
# Haiku enricher (scripts/enricher-v5-haiku.mjs) running on claw. The
# enricher POSTs observations back through ORBIT_API_URL, so no direct
# DB writes from this dispatcher.
#
# The enricher script has its own budget + resilience controls; this
# wrapper just invokes it and relays exit status.

set -u
PAYLOAD="$(cat)"

ENRICHER_SCRIPT="${ORBIT_ENRICHER_SCRIPT:-/home/sanchay/orbit/scripts/enricher-v5-haiku.mjs}"

if [[ ! -f "${ENRICHER_SCRIPT}" ]]; then
  jq -nc --arg path "${ENRICHER_SCRIPT}" \
    '{status:"failed", data:{error:"enricher script not found", path:$path}}'
  exit 0
fi

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  jq -nc '{status:"failed", data:{error:"ANTHROPIC_API_KEY not set on claw"}}'
  exit 0
fi

# Persist the payload so the enricher can pick up the targeted person_ids.
# The v5 enricher currently loads its own targets via Postgres — future
# revisions can read ORBIT_ENRICHER_TARGETS_JSON to honor the payload.
export ORBIT_ENRICHER_TARGETS_JSON="${PAYLOAD}"

START=$(date +%s)
OUT="$(node "${ENRICHER_SCRIPT}" 2>&1)"
STATUS=$?
END=$(date +%s)

if [[ "${STATUS}" -eq 0 ]]; then
  jq -nc --arg dur "$((END - START))" --arg stdout "${OUT}" \
    '{status:"succeeded", data:{duration_sec:($dur|tonumber), log_tail:$stdout}}'
else
  jq -nc --arg dur "$((END - START))" --arg code "${STATUS}" --arg stdout "${OUT}" \
    '{status:"failed", data:{duration_sec:($dur|tonumber), exit_code:($code|tonumber), log_tail:$stdout}}'
fi
