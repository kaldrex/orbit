#!/usr/bin/env bash
# Dispatcher: enricher_delta.
#
# Reads a JSON payload {scope, since?, days?, person_ids?} from stdin.
# Invokes the orbit-enricher-delta SKILL via `openclaw agent` with the
# scope verbatim. The SKILL owns candidate selection + batching + Haiku
# 4.5 call + writes.
#
# Output (stdout): {"status":"succeeded"|"failed","data":{...}}

set -u
PAYLOAD="$(cat)"
SCOPE="$(printf '%s' "${PAYLOAD}" | jq -r '.scope // "active_since_days_ago"')"
SINCE="$(printf '%s' "${PAYLOAD}" | jq -r '.since // empty')"
DAYS="$(printf '%s' "${PAYLOAD}" | jq -r '.days // 1')"
PERSON_IDS="$(printf '%s' "${PAYLOAD}" | jq -c '.person_ids // []')"

if ! command -v openclaw >/dev/null 2>&1; then
  jq -nc --arg reason "openclaw CLI not installed on host" \
    '{status:"failed", data:{error:$reason}}'
  exit 0
fi

BRIEF="Delta-bulk enrichment tick. scope=${SCOPE}"
case "${SCOPE}" in
  active_since)
    BRIEF="${BRIEF} since=${SINCE}"
    ;;
  active_since_days_ago)
    BRIEF="${BRIEF} days=${DAYS}"
    ;;
  persons)
    BRIEF="${BRIEF} person_ids=${PERSON_IDS}"
    ;;
esac
BRIEF="${BRIEF}. Follow the orbit-enricher-delta SKILL: pick candidates (skip canaries), fetch each person's last snapshot + new messages since snapshot.pass_at, batch 30 per Haiku 4.5 call, write observations + enricher snapshots. Do NOT use Sonnet or Opus for classification — Haiku 4.5 only."

START=$(date +%s)
OUT="$(openclaw agent --agent main --json --timeout 1800 --message "Run the orbit-enricher-delta skill. Brief: ${BRIEF}" 2>&1 || true)"
END=$(date +%s)

if printf '%s' "${OUT}" | jq -e '.ok == true or .status == "ok"' >/dev/null 2>&1; then
  jq -nc --arg dur "$((END - START))" --argjson raw "${OUT}" \
    '{status:"succeeded", data:{duration_sec:($dur|tonumber), raw:$raw}}'
else
  jq -nc --arg dur "$((END - START))" --arg raw "${OUT}" \
    '{status:"failed", data:{duration_sec:($dur|tonumber), error:$raw}}'
fi
