import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import {
  orbitObservationEmit,
  orbitObservationBulk,
  orbitPersonGet,
  orbitPersonsListEnriched,
  orbitSelfInit,
  orbitPersonsGoingCold,
  orbitPersonGetByEmail,
  orbitMeetingUpsert,
  orbitMeetingList,
  orbitTopicsUpsert,
  orbitTopicsGet,
  orbitCalendarFetch,
  orbitMessagesFetch,
  orbitJobsClaim,
  orbitJobsReport,
  orbitLidBridgeUpsert,
} from "./lib/client.mjs";
import { resolveConfig } from "./lib/env.mjs";

// The openclaw runtime bundles plugin-entry under dist/plugin-entry-<hash>.js
// and exports it aliased as `t` (not `definePluginEntry`). Same trick as
// orbit-rules-plugin — glob the filename so we survive hash rotations.
const require = createRequire(import.meta.url);

function findPluginEntryFile() {
  const candidates = [
    "/usr/lib/node_modules/openclaw/dist",
    "/opt/homebrew/lib/node_modules/openclaw/dist",
  ];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    const file = fs
      .readdirSync(dir)
      .find((f) => /^plugin-entry-.*\.js$/.test(f));
    if (file) return path.join(dir, file);
  }
  throw new Error(
    "orbit-cli: openclaw plugin-entry runtime not found (checked /usr/lib and /opt/homebrew)",
  );
}

const { t: definePluginEntry } = require(findPluginEntryFile());

// Each execute() returns the MCP-shaped envelope: one text content
// block whose text is JSON.stringify(result). The agent parses the
// JSON on receipt.
function envelope(result) {
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

// Tiny helper — every verb that hits Orbit short-circuits here when
// env is missing. Pulled out to keep each registerTool block small.
function withCfg(fn) {
  return async (_id, params) => {
    const cfg = resolveConfig();
    if (!cfg.ok) return envelope({ error: cfg.error });
    return envelope(await fn(params ?? {}, { config: cfg.config }));
  };
}

// Local-only verbs (calendar/messages) don't need ORBIT_API_URL/KEY for
// the shell-out itself, but orbit_messages_fetch uses orbit_person_get
// under the hood to pull the person's phones — so we resolve config
// anyway and pass it through so the nested call is authed.
function withOptionalCfg(fn) {
  return async (_id, params) => {
    const cfg = resolveConfig();
    const ctx = cfg.ok ? { config: cfg.config } : {};
    return envelope(await fn(params ?? {}, ctx));
  };
}

export default definePluginEntry({
  id: "orbit-cli",
  name: "Orbit CLI",
  description:
    "Plumbing-only wrapper around Orbit's HTTP API. 16 tools: orbit_observation_emit, orbit_observation_bulk, orbit_person_get, orbit_persons_list_enriched, orbit_self_init, orbit_persons_going_cold, orbit_person_get_by_email, orbit_meeting_upsert, orbit_meeting_list, orbit_topics_upsert, orbit_topics_get, orbit_calendar_fetch, orbit_messages_fetch, orbit_jobs_claim, orbit_jobs_report, orbit_lid_bridge_upsert.",
  register(api) {
    // --- Observations ----------------------------------------------------
    api.registerTool({
      name: "orbit_observation_emit",
      description:
        "POST a single observation to Orbit's basket (/api/v1/observations). Validates against the observation schema locally before posting. Reads ORBIT_API_URL + ORBIT_API_KEY from env. Returns {ok, accepted, inserted, deduped} on success, {error:{code, message, suggestion, body_preview?, details?}} on failure. When dry_run=true, validates locally only and returns {ok:true, dry_run:true, would_insert:1, validation:{passed:true}} — no HTTP call. No retries — log-first, retry-never.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          observation: {
            type: "object",
            description:
              "A single observation envelope matching src/lib/observations-schema.ts: {observed_at, observer, kind, evidence_pointer, confidence, reasoning, payload}. For batches use orbit_observation_bulk.",
          },
          dry_run: {
            type: "boolean",
            description:
              "If true, validate the observation locally but do not POST. Use to check shape before writing to the DB.",
          },
        },
        required: ["observation"],
      },
      execute: withCfg(orbitObservationEmit),
    });

    api.registerTool({
      name: "orbit_observation_bulk",
      description:
        "Stream-read an NDJSON file of observations, chunk to batches of 100, POST sequentially to /api/v1/observations. Per-batch failures are logged into failed_batches[]; when a batch returns 400 the offending lines are further isolated into failed_observations[{line_number, observation_snippet, error}]. Invalid JSON lines are also recorded. Returns {total_lines, batches_posted, total_inserted, total_deduped, failed_batches}. When dry_run=true, validates every line locally but makes no HTTP call — returns {ok:true, dry_run:true, total_lines, would_insert_count, would_fail:[{line_number, error}]}.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          file_path: {
            type: "string",
            description: "Absolute path to an NDJSON file (one observation per line).",
          },
          concurrency: {
            type: "number",
            description:
              "Number of batches to post in parallel. V0 supports only 1 (sequential).",
          },
          dry_run: {
            type: "boolean",
            description:
              "If true, zod-validate every line locally but do not POST. Use to check shape before writing to the DB.",
          },
        },
        required: ["file_path"],
      },
      execute: withCfg(orbitObservationBulk),
    });

    // --- Person reads ----------------------------------------------------
    api.registerTool({
      name: "orbit_person_get",
      description:
        "GET /api/v1/person/:id/card. Validates person_id is a UUID locally before issuing the request. Returns {card: PersonCard} on 200, {error:{code, message, suggestion, body_preview?}} on 404 / other HTTP failures.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          person_id: {
            type: "string",
            description: "UUID of the person (format: 36-char hex-with-dashes).",
          },
        },
        required: ["person_id"],
      },
      execute: withCfg(orbitPersonGet),
    });

    api.registerTool({
      name: "orbit_persons_list_enriched",
      description:
        "GET /api/v1/persons/enriched. Returns every person whose card has a non-'other' category OR a non-empty relationship_to_me. Pages through the server-side cursor automatically; stops at 10 pages as a circuit breaker. Used by manifest-gen's enrichment-preservation loop — regeneration should not clobber LLM-enriched fields.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          cursor: {
            type: "string",
            description:
              "Optional cursor (UUID) to resume pagination. Omit to start at the first page.",
          },
          limit: {
            type: "number",
            description:
              "Optional per-page limit. Defaults to 500; capped at 2000 by the server.",
          },
        },
      },
      execute: withCfg(orbitPersonsListEnriched),
    });

    api.registerTool({
      name: "orbit_person_get_by_email",
      description:
        "Resolve an email address to an enriched person card. Paginates /api/v1/persons/enriched client-side and returns the first card whose emails[] contains a case-insensitive match. Returns {person, found:true} on hit, {person:null, found:false} on miss, {error} on HTTP/network failure. Use this in attendee→person flows (meeting-brief, enricher) instead of hand-rolling the filter.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          email: {
            type: "string",
            description:
              "Email address to resolve. Compared case-insensitively against each person's emails[] after trim.",
          },
        },
        required: ["email"],
      },
      execute: withCfg(orbitPersonGetByEmail),
    });

    api.registerTool({
      name: "orbit_persons_going_cold",
      description:
        "GET /api/v1/persons/going-cold — list ties with score > 2 whose last_interaction_at is > 14 days old, oldest-first. Returns {persons:[{id, name, category, last_touch, days_since, score}], total}. Returns an empty list (HTTP 200) when Neo4j is unreachable or empty — the dashboard never breaks on a cold DB.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      execute: withCfg(orbitPersonsGoingCold),
    });

    // --- Self-init -------------------------------------------------------
    api.registerTool({
      name: "orbit_self_init",
      description:
        "POST /api/v1/self/init — mint / resolve the authed user's profiles.self_node_id by matching ORBIT_SELF_EMAIL / ORBIT_SELF_PHONE (read server-side) against kind:'person' observations. Idempotent: returns the existing id without rescanning. Returns {self_node_id: '<uuid>'} on success; {error:{code:'NOT_FOUND'...}} when no match exists yet.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      execute: withCfg(orbitSelfInit),
    });

    // --- Meetings --------------------------------------------------------
    api.registerTool({
      name: "orbit_meeting_upsert",
      description:
        "POST /api/v1/meetings/upcoming — upsert a batch of meeting briefs. Body: {meetings: [{meeting_id, title?, start_at, end_at?, attendees:[{email, name?, person_id?}], brief_md?}]}. Omit brief_md to preserve an existing fresh brief. Batch cap: 100. Returns {upserted:N}.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          meetings: {
            type: "array",
            description:
              "Array of meeting envelopes to upsert. Each must have meeting_id and start_at; other fields are optional.",
            items: { type: "object" },
          },
        },
        required: ["meetings"],
      },
      execute: withCfg(orbitMeetingUpsert),
    });

    api.registerTool({
      name: "orbit_meeting_list",
      description:
        "GET /api/v1/meetings/upcoming[?horizon_hours=N] — list upcoming meetings in the window. Default 72h, server-clamped to [1, 720]. Returns {meetings:[{meeting_id, title, start_at, end_at, attendees, brief_md, generated_at}]}. Use to check existing briefs before re-synthesizing.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          horizon_hours: {
            type: "number",
            description:
              "Lookahead window in hours. Default 72; max 720 (30 days).",
          },
        },
      },
      execute: withCfg(orbitMeetingList),
    });

    // --- Topics ----------------------------------------------------------
    api.registerTool({
      name: "orbit_topics_upsert",
      description:
        "POST /api/v1/person/:id/topics — atomic-replace the topic cloud for one person. Provide topics inline OR via a JSON file (exactly one). File format: {topics:[{topic, weight}]} or a bare array. Server trims + lowercases; returns {count:N}. 404 if person_id doesn't belong to the authed user.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          person_id: {
            type: "string",
            description: "UUID of the person.",
          },
          topics: {
            type: "array",
            description:
              "Inline topics. Each item: {topic: string, weight: number}. Mutually exclusive with `file`.",
            items: { type: "object" },
          },
          file: {
            type: "string",
            description:
              "Absolute path to a JSON file on claw. File must contain {topics:[...]} or a bare array of {topic, weight}.",
          },
        },
        required: ["person_id"],
      },
      execute: withCfg(orbitTopicsUpsert),
    });

    api.registerTool({
      name: "orbit_topics_get",
      description:
        "GET /api/v1/person/:id/topics[?limit=N] — read the top topics for a person, sorted by weight desc. Default limit 10, max 50. Returns {topics:[{topic, weight}], total}.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          person_id: {
            type: "string",
            description: "UUID of the person.",
          },
          limit: {
            type: "number",
            description: "Optional result cap. Default 10, max 50.",
          },
        },
        required: ["person_id"],
      },
      execute: withCfg(orbitTopicsGet),
    });

    // --- Local-only verbs (shell-out / SQLite; no Orbit POST) -----------
    api.registerTool({
      name: "orbit_calendar_fetch",
      description:
        "Shell out to `gws calendar events list` on claw and return normalized {window, events, count}. No Orbit HTTP call — pure claw-side fetch. Use this instead of hand-crafting the gws argv in a SKILL prompt. Default horizon 72h, calendarId 'primary', maxResults 50.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          horizon_hours: {
            type: "number",
            description: "Lookahead window in hours. Default 72.",
          },
          calendar_id: {
            type: "string",
            description: "Google Calendar id. Default 'primary'.",
          },
          max_results: {
            type: "number",
            description: "Event cap. Default 50.",
          },
        },
      },
      execute: withOptionalCfg(orbitCalendarFetch),
    });

    api.registerTool({
      name: "orbit_messages_fetch",
      description:
        "Read the last N WhatsApp messages (DM + groups authored by this person) from ~/.wacli/wacli.db on claw, bridging phone→LID via session.db. Uses orbit_person_get internally to pull the person's canonical phones (requires ORBIT_API_URL/KEY). Returns {person_id, messages:[{ts, body, ctx, from_me?}], count, fetched_at}. Replaces the hand-crafted SQLite queries that used to live inside the topic-resonance SKILL's script.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          person_id: {
            type: "string",
            description: "UUID of the person. Required.",
          },
          limit: {
            type: "number",
            description: "Max messages to return. Default 200, capped at 5000.",
          },
          wacli_db: {
            type: "string",
            description:
              "Optional override for ~/.wacli/wacli.db. Useful on non-claw dev hosts.",
          },
          session_db: {
            type: "string",
            description:
              "Optional override for ~/.wacli/session.db. Optional — when missing, LID bridging is skipped.",
          },
        },
        required: ["person_id"],
      },
      execute: withCfg(orbitMessagesFetch),
    });

    // --- Jobs (Phase 5 — Living Orbit) ----------------------------------
    api.registerTool({
      name: "orbit_jobs_claim",
      description:
        "POST /api/v1/jobs/claim — atomically claim the oldest unclaimed job for the authed user whose kind is in `kinds[]`. Returns {job:{id, kind, payload, attempts, created_at}} on hit, {job:null} when the queue is empty. Agents poll this from a systemd timer / openclaw scheduler.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          agent: {
            type: "string",
            description: "Agent id. Required (e.g. 'wazowski').",
          },
          kinds: {
            type: "array",
            description:
              "Non-empty list of job kinds this agent can handle (e.g. ['observer','enricher','meeting_sync','topic_resonance']).",
            items: { type: "string" },
          },
        },
        required: ["agent", "kinds"],
      },
      execute: withCfg(orbitJobsClaim),
    });

    api.registerTool({
      name: "orbit_jobs_report",
      description:
        "POST /api/v1/jobs/report — report a claimed job's outcome. status must be one of: 'succeeded', 'failed', 'retry'. 'retry' resets claimed_at so the job is re-claimable.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          job_id: {
            type: "string",
            description: "Job id returned by orbit_jobs_claim.",
          },
          status: {
            type: "string",
            description:
              "Terminal state: 'succeeded' | 'failed' | 'retry'.",
          },
          result: {
            type: "object",
            description: "Optional result payload on success.",
          },
          error: {
            type: "string",
            description: "Optional error message on failure.",
          },
        },
        required: ["job_id", "status"],
      },
      execute: withCfg(orbitJobsReport),
    });

    // --- LID bridge -----------------------------------------------------
    api.registerTool({
      name: "orbit_lid_bridge_upsert",
      description:
        "POST /api/v1/lid_bridge/upsert — bulk-upsert WhatsApp LID→phone bridge entries. The bridge is a projection of claw's ~/.wacli/session.db whatsmeow_lid_map, copied into Postgres so graph-populate can resolve `@lid`-only group senders back to persons. Body: {entries: [{lid: '<digits>', phone: '<digits>', last_seen?: '<ISO>'}]}. Max 1000 entries per call. Returns {upserted: N}. Idempotent on (user_id, lid).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          entries: {
            type: "array",
            description:
              "Array of bridge entries. Each item: {lid, phone, last_seen?}. Upserts are idempotent on (user_id, lid).",
            items: { type: "object" },
          },
        },
        required: ["entries"],
      },
      execute: withCfg(orbitLidBridgeUpsert),
    });
  },
});
