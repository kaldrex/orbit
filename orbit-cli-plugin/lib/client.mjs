// Pure-plumbing HTTP client for Orbit's three verbs. No LLM, no retries,
// no backoff — log-first, retry-never per CLAUDE.md §1. Every function
// returns a plain object; HTTP failures come back as {error: {...}} not
// thrown, so the agent loop can decide what to do.
//
// Config is passed in from lib/env.mjs — we never touch the environment
// directly from this file. See that module for the URL + key contract.
//
// NEVER prepend '/api/v1' to paths — the configured base already includes
// it. This is the canonical double-prepend gotcha; unit-tested in
// tests/unit/orbit-cli-plugin.test.mjs.
//
// Error shape: every {error: {...}} conforms to lib/errors.mjs — stable
// `code` enum the agent can pattern-match on, plus a one-line `suggestion`
// the agent can surface to the user.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { observationSchema, MAX_BATCH, UUID_RE } from "./schema.mjs";
import { resolveConfig } from "./env.mjs";
import {
  validationError,
  httpError,
  networkError,
  invalidUuidError,
  maxBatchExceededError,
  fileNotFoundError,
  emptyFileError,
  invalidInputError,
} from "./errors.mjs";

const DEFAULT_CONCURRENCY = 1;

function authHeaders(key) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
  };
}

// Never re-prepend /api/v1 — the configured base URL already contains it.
// Tool paths are relative to the base: /observations, /person/:id/card.
function joinUrl(base, relPath) {
  const path = relPath.startsWith("/") ? relPath : `/${relPath}`;
  return `${base}${path}`;
}

async function readBody(res) {
  const ct = res.headers.get?.("content-type") ?? "";
  const text = await res.text();
  if (ct.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text.slice(0, 500) };
    }
  }
  return { raw: text.slice(0, 500) };
}

/**
 * POST a single observation to /observations. Validates locally first.
 * Returns {ok, accepted, inserted, deduped} on 2xx; {error: {code,...}} otherwise.
 *
 * dry_run=true: validate locally only, no HTTP call. Returns
 * {ok:true, dry_run:true, would_insert:1, validation:{passed:true}} on success,
 * or the normal validation-error envelope on failure.
 */
export async function orbitObservationEmit(
  { observation, dry_run = false } = {},
  { config, fetchImpl = fetch } = {},
) {
  if (observation === undefined || observation === null) {
    return invalidInputError(
      "observation is required",
      "Pass {observation: {...}} — a single observation envelope. For batches use orbit_observation_bulk.",
    );
  }
  // Defensive: someone passes an array to emit() — push back to bulk().
  if (Array.isArray(observation)) {
    return invalidInputError(
      "orbit_observation_emit takes ONE observation, not an array",
      "Use orbit_observation_bulk for batches — it writes an NDJSON file and chunks to 100/batch.",
    );
  }
  const parsed = observationSchema.safeParse(observation);
  if (!parsed.success) {
    return validationError(parsed.error);
  }

  if (dry_run) {
    return {
      ok: true,
      dry_run: true,
      would_insert: 1,
      validation: { passed: true },
    };
  }

  const { url, key } = config ?? resolveConfig();
  const target = joinUrl(url, "/observations");
  let res;
  try {
    res = await fetchImpl(target, {
      method: "POST",
      headers: authHeaders(key),
      body: JSON.stringify([parsed.data]),
    });
  } catch (e) {
    return networkError(e);
  }
  const body = await readBody(res);
  if (!res.ok) return httpError(res, body);
  return {
    ok: true,
    accepted: body.accepted ?? 1,
    inserted: body.inserted ?? 0,
    deduped: body.deduped ?? 0,
  };
}

// --- bulk helpers ---------------------------------------------------------

/**
 * Re-POST each observation in a batch individually to isolate which specific
 * line(s) the server rejected. Only invoked when the full-batch POST returned
 * a 400 — 500s and network errors are whole-batch failures and don't benefit
 * from per-line splitting (and would amplify server load).
 */
async function isolateBatchFailures(
  batch,
  batchMeta,
  { target, key, fetchImpl },
) {
  const failed_observations = [];
  for (let j = 0; j < batch.length; j += 1) {
    const { obs, line_number } = batch[j];
    let res;
    try {
      res = await fetchImpl(target, {
        method: "POST",
        headers: authHeaders(key),
        body: JSON.stringify([obs]),
      });
    } catch (e) {
      const net = networkError(e).error;
      failed_observations.push({
        line_number,
        observation_snippet: JSON.stringify(obs).slice(0, 800),
        error: { code: net.code, message: net.message },
      });
      continue;
    }
    if (res.ok) continue; // this one was fine; another line in the batch caused the 400
    const body = await readBody(res);
    const err = httpError(res, body).error;
    failed_observations.push({
      line_number,
      observation_snippet: JSON.stringify(obs).slice(0, 800),
      error: { code: err.code, message: err.message },
    });
  }
  return failed_observations;
}

/**
 * Stream-read an NDJSON file, chunk to MAX_BATCH, POST each chunk sequentially.
 * Failures in one batch don't abort the run — logged + collected in failed_batches.
 * When a batch returns 400, we re-post its lines one-at-a-time to identify
 * exactly which observations failed — those populate `failed_observations`
 * inside the batch's failed_batches entry.
 *
 * dry_run=true: read the file, zod-validate each non-blank line, no HTTP.
 * Returns {ok:true, dry_run:true, total_lines, would_insert_count, would_fail:[{line_number, error}]}.
 */
export async function orbitObservationBulk(
  { file_path, concurrency = DEFAULT_CONCURRENCY, dry_run = false } = {},
  { config, fetchImpl = fetch } = {},
) {
  if (!file_path || typeof file_path !== "string") {
    return invalidInputError(
      "file_path (string) is required",
      "Pass {file_path: '/abs/path/observations.ndjson'} pointing to an NDJSON file on the gateway host.",
    );
  }
  // Reject concurrency > 1 for V0 — sequential is the safety default.
  if (concurrency !== DEFAULT_CONCURRENCY) {
    return invalidInputError(
      `concurrency=${concurrency} not supported in V0; only concurrency=1 (sequential)`,
      "Remove the `concurrency` parameter or set it to 1.",
    );
  }

  try {
    await stat(file_path);
  } catch (e) {
    return fileNotFoundError(file_path);
  }

  // Stream-read the file line-by-line. Skip blank lines. Parse each as JSON.
  // Invalid JSON lines are collected as parse-error entries with line_number.
  const parseErrors = [];
  // Each item: {obs, line_number}
  const parsedLines = [];
  let total_lines = 0;
  const stream = createReadStream(file_path, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lineIdx = 0;
  for await (const rawLine of rl) {
    lineIdx += 1;
    const line = rawLine.trim();
    if (!line) continue;
    total_lines += 1;
    try {
      parsedLines.push({ obs: JSON.parse(line), line_number: lineIdx });
    } catch (e) {
      parseErrors.push({
        line_number: lineIdx,
        reason: `json parse: ${e?.message ?? e}`,
      });
      continue;
    }
  }

  // Empty-file: zero non-blank, zero parseable lines.
  if (total_lines === 0) {
    return emptyFileError(file_path);
  }

  // --- dry-run branch ---------------------------------------------------
  if (dry_run) {
    let would_insert_count = 0;
    const would_fail = [];
    // Surface JSON parse errors as dry-run failures.
    for (const pe of parseErrors) {
      would_fail.push({
        line_number: pe.line_number,
        error: {
          code: "VALIDATION_FAILED",
          message: pe.reason,
          suggestion: "Fix the JSON syntax on this line.",
        },
      });
    }
    for (const { obs, line_number } of parsedLines) {
      const parsed = observationSchema.safeParse(obs);
      if (parsed.success) {
        would_insert_count += 1;
      } else {
        const err = validationError(parsed.error).error;
        would_fail.push({ line_number, error: err });
      }
    }
    return {
      ok: true,
      dry_run: true,
      total_lines,
      would_insert_count,
      would_fail,
    };
  }

  // --- real POST branch -------------------------------------------------
  // Build batches preserving line_number so we can report per-obs on failure.
  const batches = [];
  for (let i = 0; i < parsedLines.length; i += MAX_BATCH) {
    batches.push(parsedLines.slice(i, i + MAX_BATCH));
  }

  const failed_batches = parseErrors.map((pe) => ({
    batch_index: -1,
    start_line: pe.line_number,
    end_line: pe.line_number,
    http_status: 0,
    error: {
      code: "VALIDATION_FAILED",
      message: pe.reason,
    },
    failed_observations: [
      {
        line_number: pe.line_number,
        observation_snippet: "",
        error: { code: "VALIDATION_FAILED", message: pe.reason },
      },
    ],
  }));

  if (batches.length === 0) {
    return {
      total_lines,
      batches_posted: 0,
      total_inserted: 0,
      total_deduped: 0,
      failed_batches,
    };
  }

  const { url, key } = config ?? resolveConfig();
  const target = joinUrl(url, "/observations");

  let total_inserted = 0;
  let total_deduped = 0;
  let batches_posted = 0;

  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    const payload = batch.map((b) => b.obs);
    const start_line = batch[0].line_number;
    const end_line = batch[batch.length - 1].line_number;
    batches_posted += 1;
    let res;
    try {
      res = await fetchImpl(target, {
        method: "POST",
        headers: authHeaders(key),
        body: JSON.stringify(payload),
      });
    } catch (e) {
      const err = networkError(e).error;
      failed_batches.push({
        batch_index: i,
        start_line,
        end_line,
        http_status: 0,
        error: err,
        failed_observations: [], // whole batch — no isolation for network failures
      });
      continue;
    }
    const body = await readBody(res);
    if (!res.ok) {
      const err = httpError(res, body).error;
      let failed_observations = [];
      // Only isolate per-observation when the server rejected the shape (400).
      // 5xx / 429 / auth → whole-batch failure, no retry-to-split.
      if (res.status === 400) {
        failed_observations = await isolateBatchFailures(batch, null, {
          target,
          key,
          fetchImpl,
        });
      }
      failed_batches.push({
        batch_index: i,
        start_line,
        end_line,
        http_status: res.status,
        error: err,
        failed_observations,
      });
      continue;
    }
    total_inserted += body.inserted ?? 0;
    total_deduped += body.deduped ?? 0;
  }

  return {
    total_lines,
    batches_posted,
    total_inserted,
    total_deduped,
    failed_batches,
  };
}

/**
 * GET /person/:id/card. Validates UUID format locally first.
 * Returns {card: PersonCard} on 200; {error: {code,...}} on 404 / other.
 */
export async function orbitPersonGet(
  { person_id } = {},
  { config, fetchImpl = fetch } = {},
) {
  if (!person_id || typeof person_id !== "string") {
    return invalidInputError(
      "person_id (string) is required",
      "Pass {person_id: '<uuid>'}.",
    );
  }
  if (!UUID_RE.test(person_id)) {
    return invalidUuidError(person_id);
  }

  const { url, key } = config ?? resolveConfig();
  const target = joinUrl(url, `/person/${person_id}/card`);
  let res;
  try {
    res = await fetchImpl(target, { method: "GET", headers: authHeaders(key) });
  } catch (e) {
    return networkError(e);
  }
  const body = await readBody(res);
  if (!res.ok) return httpError(res, body);
  return body;
}

/**
 * GET /persons/enriched — paginate through the enriched-persons list and
 * return {persons[], warnings?[]}. Follows server-side cursor. Stops at
 * 10 pages as a circuit breaker and flags a warning if hit.
 */
export async function orbitPersonsListEnriched(
  { cursor, limit } = {},
  { config, fetchImpl = fetch } = {},
) {
  const cfg = config ?? resolveConfig();
  // resolveConfig now returns {ok, config} envelope — unwrap.
  const effective =
    cfg && typeof cfg === "object" && "ok" in cfg
      ? cfg.ok
        ? cfg.config
        : null
      : cfg;
  if (!effective) {
    return invalidInputError(
      "ORBIT_API_URL / ORBIT_API_KEY must be set",
      "Check the gateway env before calling orbit_persons_list_enriched.",
    );
  }
  const { url, key } = effective;
  const MAX_PAGES = 10;
  const all = [];
  const warnings = [];
  let nextCursor = typeof cursor === "string" ? cursor : null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const qs = new URLSearchParams();
    if (limit) qs.set("limit", String(limit));
    if (nextCursor) qs.set("cursor", nextCursor);
    const q = qs.toString();
    const target = joinUrl(url, `/persons/enriched${q ? `?${q}` : ""}`);
    let res;
    try {
      res = await fetchImpl(target, {
        method: "GET",
        headers: authHeaders(key),
      });
    } catch (e) {
      return networkError(e);
    }
    const body = await readBody(res);
    if (!res.ok) return httpError(res, body);
    if (Array.isArray(body?.persons)) {
      all.push(...body.persons);
    }
    if (!body?.next_cursor) {
      return { persons: all };
    }
    nextCursor = body.next_cursor;
  }
  warnings.push({
    code: "PAGINATION_CIRCUIT_BREAK",
    message: `hit ${MAX_PAGES}-page limit; result may be partial`,
  });
  return { persons: all, warnings };
}

// Exported for tests.
export const __test = { joinUrl };
