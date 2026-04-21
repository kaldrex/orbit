#!/usr/bin/env bash
# Dispatcher: topic_resonance.
#
# Runs the topic-resonance skill against the payload's person_ids (or a
# default sweep if none given). Emits topic weights via orbit_topics_upsert.

set -u
PAYLOAD="$(cat)"

if ! command -v openclaw >/dev/null 2>&1; then
  jq -nc '{status:"failed", data:{error:"openclaw CLI not installed on host"}}'
  exit 0
fi

BRIEF="Run orbit-topic-resonance SKILL with payload: ${PAYLOAD}. For each person_id, fetch recent messages via orbit_messages_fetch, infer topic weights, upsert via orbit_topics_upsert."

START=$(date +%s)
OUT="$(openclaw agent --agent main --json --timeout 1200 --message "Run the orbit-topic-resonance skill. Brief: ${BRIEF}" 2>&1 || true)"
END=$(date +%s)

if printf '%s' "${OUT}" | jq -e '.ok == true' >/dev/null 2>&1; then
  jq -nc --arg dur "$((END - START))" --argjson raw "${OUT}" \
    '{status:"succeeded", data:{duration_sec:($dur|tonumber), raw:$raw}}'
else
  jq -nc --arg dur "$((END - START))" --arg raw "${OUT}" \
    '{status:"failed", data:{duration_sec:($dur|tonumber), error:$raw}}'
fi
