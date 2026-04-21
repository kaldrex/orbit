#!/usr/bin/env bash
# Dispatcher: enricher (14-day cadence).
#
# Reads a JSON payload {limit?: number} from stdin. Fires the
# orbit-enricher SKILL headlessly via `openclaw agent`. The SKILL
# pulls up to `limit` (default 30) skeleton persons via
# orbit_persons_list_enriched, fetches their recent WhatsApp context,
# classifies the whole batch in ONE Sonnet 4 call (funded by the
# founder's ANTHROPIC_API_KEY on claw), and emits person observations
# back through orbit_observation_bulk.
#
# No direct DB writes. No Node-script shell-out. All LLM judgment lives
# in the SKILL; this wrapper is pure plumbing.
#
# Output (stdout): {"status":"succeeded"|"failed","data":{...}}

set -u
PAYLOAD="$(cat)"
LIMIT="$(printf '%s' "${PAYLOAD}" | jq -r '.limit // 30')"

if ! command -v openclaw >/dev/null 2>&1; then
  jq -nc '{status:"failed", data:{error:"openclaw CLI not installed on host"}}'
  exit 0
fi

BRIEF="Phase 5 living-orbit tick: enrich up to ${LIMIT} persons whose latest card has category='other'. Use orbit_persons_list_enriched to find them (skip canaries Umayr 67050b91-5011-4ba6-b230-9a387879717a and Ramon 9e7c0448-dd3b-437c-9cda-c512dbc5764b), orbit_messages_fetch per person (limit 30), ONE claude-sonnet-4-20250514 call for the whole batch, orbit_observation_bulk to write observations. Return JSON summary with {ok, status, batch_size, enriched, skipped_no_signal, inserted, deduped, category_shift, cost_usd}."

START=$(date +%s)
OUT="$(openclaw agent --agent main --json --timeout 1500 --message "Run the orbit-enricher skill. Brief: ${BRIEF}" 2>&1 || true)"
END=$(date +%s)

if printf '%s' "${OUT}" | jq -e '.ok == true' >/dev/null 2>&1; then
  jq -nc --arg dur "$((END - START))" --argjson raw "${OUT}" \
    '{status:"succeeded", data:{duration_sec:($dur|tonumber), raw:$raw}}'
else
  jq -nc --arg dur "$((END - START))" --arg raw "${OUT}" \
    '{status:"failed", data:{duration_sec:($dur|tonumber), error:$raw}}'
fi
