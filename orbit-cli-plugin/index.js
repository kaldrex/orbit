import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import {
  orbitObservationEmit,
  orbitObservationBulk,
  orbitPersonGet,
  orbitPersonsListEnriched,
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

export default definePluginEntry({
  id: "orbit-cli",
  name: "Orbit CLI",
  description:
    "Plumbing-only wrapper around Orbit's HTTP API. Three tools: orbit_observation_emit, orbit_observation_bulk, orbit_person_get.",
  register(api) {
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
      execute: async (_id, params) => {
        const cfg = resolveConfig();
        if (!cfg.ok) return envelope({ error: cfg.error });
        return envelope(
          await orbitObservationEmit(params ?? {}, { config: cfg.config }),
        );
      },
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
      execute: async (_id, params) => {
        const cfg = resolveConfig();
        if (!cfg.ok) return envelope({ error: cfg.error });
        return envelope(
          await orbitObservationBulk(params ?? {}, { config: cfg.config }),
        );
      },
    });

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
      execute: async (_id, params) => {
        const cfg = resolveConfig();
        if (!cfg.ok) return envelope({ error: cfg.error });
        return envelope(
          await orbitPersonGet(params ?? {}, { config: cfg.config }),
        );
      },
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
      execute: async (_id, params) => {
        const cfg = resolveConfig();
        if (!cfg.ok) return envelope({ error: cfg.error });
        return envelope(
          await orbitPersonsListEnriched(params ?? {}, { config: cfg.config }),
        );
      },
    });
  },
});
