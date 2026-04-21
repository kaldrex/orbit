// Pure-plumbing HTTP client for Orbit's three verbs. No LLM, no retries,
// no backoff — log-first, retry-never per CLAUDE.md §1. Every function
// returns a plain object; HTTP failures come back as {error: {...}} not
// thrown, so the agent loop can decide what to do.
//
// Config is passed in from lib/env.mjs — we never touch the environment
// directly from this file. See that module for the URL + key contract.
//
// URL contract: ORBIT_API_BASE is the bare host (no /api/v1). joinUrl()
// below is the single place that appends the /api/v1 path prefix.
// This means every verb's `relPath` is a route-relative path like
// "/observations" or "/person/:id/card". Unit-tested in
// tests/unit/orbit-cli-plugin.test.mjs.
//
// Error shape: every {error: {...}} conforms to lib/errors.mjs — stable
// `code` enum the agent can pattern-match on, plus a one-line `suggestion`
// the agent can surface to the user.

import { createReadStream, existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
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

// Base is the bare host (e.g. http://100.97.152.84:3047). We append
// /api/v1 exactly once here, then the route-relative path. Tool paths
// passed in by verbs are like /observations, /person/:id/card.
function joinUrl(base, relPath) {
  const path = relPath.startsWith("/") ? relPath : `/${relPath}`;
  return `${base}/api/v1${path}`;
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
      "ORBIT_API_BASE / ORBIT_API_KEY must be set",
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

// -------------------------------------------------------------------------
// Small helper: unwrap {ok, config} envelope (or a pre-unwrapped config).
// Shared by every new verb below.
// -------------------------------------------------------------------------
function unwrapConfig(cfg) {
  const resolved = cfg ?? resolveConfig();
  const effective =
    resolved && typeof resolved === "object" && "ok" in resolved
      ? resolved.ok
        ? resolved.config
        : null
      : resolved;
  if (!effective) {
    return {
      error: invalidInputError(
        "ORBIT_API_BASE / ORBIT_API_KEY must be set",
        "Check the gateway env before calling this verb.",
      ).error,
    };
  }
  return { config: effective };
}

/**
 * POST /self/init — mint / resolve profiles.self_node_id.
 * Server is idempotent (returns existing id when already set).
 *
 * Body is empty; server reads ORBIT_SELF_EMAIL / ORBIT_SELF_PHONE from its
 * own env and matches kind:"person" observations.
 *
 * Returns {self_node_id: "<uuid>"} on 200; {error} on any non-2xx.
 */
export async function orbitSelfInit(
  _params = {},
  { config, fetchImpl = fetch } = {},
) {
  const w = unwrapConfig(config);
  if (w.error) return { error: w.error };
  const { url, key } = w.config;
  const target = joinUrl(url, "/self/init");
  let res;
  try {
    res = await fetchImpl(target, {
      method: "POST",
      headers: authHeaders(key),
      body: JSON.stringify({}),
    });
  } catch (e) {
    return networkError(e);
  }
  const body = await readBody(res);
  if (!res.ok) return httpError(res, body);
  return body;
}

/**
 * GET /persons/going-cold — list dormant ties (score > 2,
 * last_interaction_at > 14 days old). Server returns {persons[], total}.
 */
export async function orbitPersonsGoingCold(
  _params = {},
  { config, fetchImpl = fetch } = {},
) {
  const w = unwrapConfig(config);
  if (w.error) return { error: w.error };
  const { url, key } = w.config;
  const target = joinUrl(url, "/persons/going-cold");
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
 * Resolve an email → enriched person card. There is no server-side
 * `?q=<email>` filter on /persons/enriched today, so this paginates
 * client-side and returns the FIRST person whose `emails[]` contains a
 * case-insensitive match.
 *
 * Returns {person: {...}} or {person: null, found: false} if no match.
 * {error} on HTTP/network failure.
 */
export async function orbitPersonGetByEmail(
  { email } = {},
  { config, fetchImpl = fetch } = {},
) {
  if (!email || typeof email !== "string") {
    return invalidInputError(
      "email (string) is required",
      "Pass {email: 'user@example.com'} — the email to resolve to a person card.",
    );
  }
  const target = email.trim().toLowerCase();
  if (!target) {
    return invalidInputError(
      "email is empty after trim",
      "Pass a non-empty email address.",
    );
  }
  // Reuse the paginating list verb — same circuit-breaker, same auth.
  const listed = await orbitPersonsListEnriched(
    {},
    { config, fetchImpl },
  );
  if (listed.error) return listed;
  const match = (listed.persons ?? []).find((p) => {
    if (!Array.isArray(p.emails)) return false;
    return p.emails.some(
      (e) => typeof e === "string" && e.trim().toLowerCase() === target,
    );
  });
  if (!match) return { person: null, found: false };
  return { person: match, found: true };
}

/**
 * POST /meetings/upcoming — upsert a batch of meetings/briefs.
 *
 * params.meetings: array of {meeting_id, title?, start_at, end_at?,
 *                   attendees[], brief_md?}.
 *
 * Returns {upserted: N} on 2xx. Orbit route validates shape server-side;
 * the CLI does a minimal pre-check (non-empty array, <= 100 entries).
 */
export async function orbitMeetingUpsert(
  { meetings } = {},
  { config, fetchImpl = fetch } = {},
) {
  if (!Array.isArray(meetings)) {
    return invalidInputError(
      "meetings (array) is required",
      "Pass {meetings: [{meeting_id, start_at, attendees:[...], ...}]}.",
    );
  }
  if (meetings.length === 0) {
    return invalidInputError(
      "meetings array is empty",
      "Pass at least one meeting entry; empty batches are rejected server-side.",
    );
  }
  if (meetings.length > 100) {
    return invalidInputError(
      `meetings batch size ${meetings.length} exceeds server cap of 100`,
      "Split the batch into chunks of at most 100 meetings.",
    );
  }
  const w = unwrapConfig(config);
  if (w.error) return { error: w.error };
  const { url, key } = w.config;
  const target = joinUrl(url, "/meetings/upcoming");
  let res;
  try {
    res = await fetchImpl(target, {
      method: "POST",
      headers: authHeaders(key),
      body: JSON.stringify({ meetings }),
    });
  } catch (e) {
    return networkError(e);
  }
  const body = await readBody(res);
  if (!res.ok) return httpError(res, body);
  return body;
}

/**
 * GET /meetings/upcoming?horizon_hours=<N>. Returns {meetings[]}.
 * Default horizon = 72h (server default). Clamped server-side to [1, 720].
 */
export async function orbitMeetingList(
  { horizon_hours } = {},
  { config, fetchImpl = fetch } = {},
) {
  const w = unwrapConfig(config);
  if (w.error) return { error: w.error };
  const { url, key } = w.config;
  const qs = new URLSearchParams();
  if (horizon_hours !== undefined && horizon_hours !== null) {
    qs.set("horizon_hours", String(horizon_hours));
  }
  const q = qs.toString();
  const target = joinUrl(url, `/meetings/upcoming${q ? `?${q}` : ""}`);
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
 * POST /person/:id/topics — atomic replace of topic weights.
 *
 * params: {person_id, topics?: [{topic, weight}], file?: absolute path
 *          to a JSON file containing {topics: [...]} or a raw array}.
 *
 * Exactly one of topics / file must be provided.
 */
export async function orbitTopicsUpsert(
  { person_id, topics, file } = {},
  { config, fetchImpl = fetch } = {},
) {
  if (!person_id || typeof person_id !== "string") {
    return invalidInputError(
      "person_id (string) is required",
      "Pass {person_id: '<uuid>', topics: [{topic, weight}]}.",
    );
  }
  if (!UUID_RE.test(person_id)) {
    return invalidUuidError(person_id);
  }
  const haveTopics = Array.isArray(topics);
  const haveFile = typeof file === "string" && file.length > 0;
  if (haveTopics === haveFile) {
    // both or neither
    return invalidInputError(
      "exactly one of {topics, file} must be provided",
      "Pass either {topics: [...]} inline OR {file: '/abs/path.json'} — not both, not neither.",
    );
  }
  let effectiveTopics = topics;
  if (haveFile) {
    try {
      await stat(file);
    } catch {
      return fileNotFoundError(file);
    }
    let raw;
    try {
      raw = await readFile(file, "utf8");
    } catch (e) {
      return invalidInputError(
        `failed to read topics file: ${e?.message ?? e}`,
        "Check the file is readable by the gateway process on claw.",
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return invalidInputError(
        `topics file is not valid JSON: ${e?.message ?? e}`,
        "File must contain {\"topics\":[...]} or a bare array of {topic,weight}.",
      );
    }
    if (Array.isArray(parsed)) effectiveTopics = parsed;
    else if (parsed && Array.isArray(parsed.topics)) effectiveTopics = parsed.topics;
    else {
      return invalidInputError(
        "topics file has no {topics:[...]} array",
        "File must contain {\"topics\":[...]} or a bare array of {topic,weight}.",
      );
    }
  }
  const w = unwrapConfig(config);
  if (w.error) return { error: w.error };
  const { url, key } = w.config;
  const target = joinUrl(url, `/person/${person_id}/topics`);
  let res;
  try {
    res = await fetchImpl(target, {
      method: "POST",
      headers: authHeaders(key),
      body: JSON.stringify({ topics: effectiveTopics }),
    });
  } catch (e) {
    return networkError(e);
  }
  const body = await readBody(res);
  if (!res.ok) return httpError(res, body);
  return body;
}

/**
 * GET /person/:id/topics[?limit=N]. Returns {topics[], total}.
 */
export async function orbitTopicsGet(
  { person_id, limit } = {},
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
  const w = unwrapConfig(config);
  if (w.error) return { error: w.error };
  const { url, key } = w.config;
  const qs = new URLSearchParams();
  if (limit !== undefined && limit !== null) qs.set("limit", String(limit));
  const q = qs.toString();
  const target = joinUrl(url, `/person/${person_id}/topics${q ? `?${q}` : ""}`);
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

// --- local helpers (not HTTP) -------------------------------------------

/**
 * Run a child process, buffer stdout/stderr, return {code, stdout, stderr}.
 * No retries, no shell. `cmd` is argv[0], `args` is argv[1..].
 * spawnImpl is injectable for tests.
 */
function runChild(cmd, args, { cwd, env, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    const child = spawnImpl(cmd, args, { cwd, env, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => {
      stdout += c.toString();
    });
    child.stderr?.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("error", (e) => {
      resolve({ code: -1, stdout, stderr: String(e?.message ?? e) });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

/**
 * Shell out to `gws calendar events list` on claw and normalize the
 * response to a plain {events: [...]}. No Orbit HTTP call. Used by
 * orbit-meeting-brief SKILL to avoid hand-crafting gws argv in the
 * prompt.
 *
 * params.horizon_hours: default 72.
 * params.calendar_id: default "primary".
 * params.max_results: default 50.
 */
export async function orbitCalendarFetch(
  {
    horizon_hours = 72,
    calendar_id = "primary",
    max_results = 50,
    // injectables for tests
    now = () => new Date(),
    spawnImpl,
    gwsBin = "gws",
  } = {},
  _ctx = {},
) {
  if (
    typeof horizon_hours !== "number" ||
    !Number.isFinite(horizon_hours) ||
    horizon_hours <= 0
  ) {
    return invalidInputError(
      "horizon_hours must be a positive number",
      "Pass {horizon_hours: 72} — the lookahead window in hours.",
    );
  }
  const t0 = now();
  const t1 = new Date(t0.getTime() + horizon_hours * 3600 * 1000);
  const params = {
    calendarId: calendar_id,
    timeMin: t0.toISOString(),
    timeMax: t1.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: max_results,
  };
  const { code, stdout, stderr } = await runChild(
    gwsBin,
    ["calendar", "events", "list", "--params", JSON.stringify(params)],
    { spawnImpl },
  );
  if (code !== 0) {
    return {
      error: {
        code: "NETWORK_ERROR",
        message: `gws calendar events list exited ${code}`,
        suggestion:
          "Check `gws` is installed on claw and the calendar token is fresh. Re-auth via `gws auth login` if needed.",
        body_preview: (stderr || stdout).slice(0, 500),
      },
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    return {
      error: {
        code: "VALIDATION_FAILED",
        message: `gws returned non-JSON output: ${e?.message ?? e}`,
        suggestion:
          "gws should be invoked without --format text. The fetcher pins JSON; if gws is wrapped, ensure the wrapper preserves stdout.",
        body_preview: String(stdout).slice(0, 500),
      },
    };
  }
  const items = Array.isArray(parsed?.items)
    ? parsed.items
    : Array.isArray(parsed)
      ? parsed
      : [];
  return {
    window: { timeMin: params.timeMin, timeMax: params.timeMax },
    events: items,
    count: items.length,
  };
}

/**
 * Local SQLite read on claw: fetch the last N messages (DM + group-authored)
 * for a person_id, bridging phone→LID via session.db. Returns
 * {person_id, messages: [{ts, body, ctx, from_me?}]}. No Orbit HTTP call —
 * pure claw-side plumbing so the topic-resonance SKILL doesn't re-hand-
 * craft the SQL in its prompt.
 *
 * params.person_id: UUID. Required.
 * params.limit: max messages (default 200).
 * params.wacli_db / params.session_db: override paths (for tests).
 * params.sqliteImpl: injectable `better-sqlite3` module for tests.
 */
export async function orbitMessagesFetch(
  {
    person_id,
    limit = 200,
    wacli_db,
    session_db,
    config,
    fetchImpl = fetch,
    sqliteImpl,
    now = () => Date.now(),
    orbitPersonGetImpl = orbitPersonGet,
  } = {},
  _ctx = {},
) {
  if (!person_id || typeof person_id !== "string") {
    return invalidInputError(
      "person_id (string) is required",
      "Pass {person_id: '<uuid>', limit?: 200}.",
    );
  }
  if (!UUID_RE.test(person_id)) {
    return invalidUuidError(person_id);
  }
  if (!Number.isFinite(limit) || limit <= 0 || limit > 5000) {
    return invalidInputError(
      `limit=${limit} out of range (1..5000)`,
      "Pass limit between 1 and 5000.",
    );
  }
  // Default paths: env override → ~/.wacli/wacli.db and ~/.wacli/session.db.
  const defaultWacli =
    wacli_db || process.env.WACLI_DB_PATH || `${process.env.HOME}/.wacli/wacli.db`;
  const defaultSession =
    session_db ||
    process.env.SESSION_DB_PATH ||
    `${process.env.HOME}/.wacli/session.db`;
  if (!existsSync(defaultWacli)) {
    return fileNotFoundError(defaultWacli);
  }

  // Pull phones via the card so we know which JIDs to query.
  const card = await orbitPersonGetImpl(
    { person_id },
    { config, fetchImpl },
  );
  if (card.error) return card;
  const phones = Array.isArray(card.card?.phones) ? card.card.phones : [];
  if (phones.length === 0) {
    return { person_id, messages: [], count: 0, reason: "no_phones_on_card" };
  }

  // Lazy-load sqlite so the CLI still imports on hosts without the module.
  let Database = sqliteImpl;
  if (!Database) {
    try {
      const mod = await import("better-sqlite3");
      Database = mod.default ?? mod;
    } catch (e) {
      return {
        error: {
          code: "VALIDATION_FAILED",
          message: `better-sqlite3 not available: ${e?.message ?? e}`,
          suggestion:
            "Install better-sqlite3 in the gateway node_modules on claw.",
        },
      };
    }
  }

  // Load phone → LID map (optional; session.db may be absent).
  const phoneToLid = new Map();
  if (existsSync(defaultSession)) {
    const sdb = new Database(defaultSession, { readonly: true });
    try {
      const rows = sdb
        .prepare("SELECT lid, pn FROM whatsmeow_lid_map")
        .all();
      for (const r of rows) {
        const pn = String(r.pn || "").trim().replace(/\D+/g, "");
        const lid = String(r.lid || "").trim().split(":")[0];
        if (pn && lid) phoneToLid.set(pn, lid);
      }
    } finally {
      sdb.close();
    }
  }

  const wdb = new Database(defaultWacli, { readonly: true });
  const out = [];
  const seen = new Set();
  try {
    const dmStmt = wdb.prepare(`
      SELECT ts, from_me,
             COALESCE(NULLIF(text,''), NULLIF(display_text,''), NULLIF(media_caption,'')) AS body,
             chat_name
        FROM messages
       WHERE chat_jid = ?
         AND COALESCE(NULLIF(text,''), NULLIF(display_text,''), NULLIF(media_caption,'')) IS NOT NULL
       ORDER BY ts DESC
       LIMIT ?
    `);
    const grpByJid = wdb.prepare(`
      SELECT m.ts, m.chat_name,
             COALESCE(NULLIF(m.text,''), NULLIF(m.display_text,''), NULLIF(m.media_caption,'')) AS body
        FROM messages m
       WHERE m.sender_jid = ?
         AND m.chat_jid LIKE '%@g.us'
         AND COALESCE(NULLIF(m.text,''), NULLIF(m.display_text,''), NULLIF(m.media_caption,'')) IS NOT NULL
       ORDER BY m.ts DESC
       LIMIT ?
    `);
    for (const phone of phones) {
      const digits = String(phone).replace(/\D+/g, "");
      if (!digits) continue;
      const dmJid = `${digits}@s.whatsapp.net`;
      for (const m of dmStmt.all(dmJid, limit)) {
        if (!m.body) continue;
        const key = `${m.ts}|${String(m.body).slice(0, 40)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          ts: m.ts,
          body: String(m.body).trim(),
          ctx: "dm",
          from_me: !!m.from_me,
        });
      }
      const lid = phoneToLid.get(digits);
      if (lid) {
        for (const m of grpByJid.all(`${lid}@lid`, limit)) {
          if (!m.body) continue;
          const key = `${m.ts}|${String(m.body).slice(0, 40)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            ts: m.ts,
            body: String(m.body).trim(),
            ctx: `grp:${m.chat_name ?? ""}`,
          });
        }
      }
      // Pre-LID era: groups where sender_jid is still the phone-JID.
      for (const m of grpByJid.all(dmJid, limit)) {
        if (!m.body) continue;
        const key = `${m.ts}|${String(m.body).slice(0, 40)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          ts: m.ts,
          body: String(m.body).trim(),
          ctx: `grp:${m.chat_name ?? ""}`,
        });
      }
    }
  } finally {
    wdb.close();
  }
  out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const trimmed = out.slice(0, limit);
  return {
    person_id,
    messages: trimmed,
    count: trimmed.length,
    fetched_at: new Date(now()).toISOString(),
  };
}

/**
 * POST /jobs/claim — Phase 5 (live). Atomically claim the oldest unclaimed
 * job whose kind is in `kinds[]`. Returns {job: {id, kind, payload,
 * attempts, created_at}} on hit, {job: null} when the queue is empty.
 *
 * params.agent: agent id string (e.g. "wazowski"). Required.
 * params.kinds: non-empty array of job kinds this agent can handle
 *               (e.g. ["observer","enricher","meeting_sync","topic_resonance"]).
 */
export async function orbitJobsClaim(
  { agent, kinds } = {},
  { config, fetchImpl = fetch } = {},
) {
  if (!agent || typeof agent !== "string") {
    return invalidInputError(
      "agent (string) is required",
      "Pass {agent: 'wazowski', kinds: ['observer','enricher',...]}.",
    );
  }
  if (!Array.isArray(kinds) || kinds.length === 0) {
    return invalidInputError(
      "kinds (non-empty string array) is required",
      "Pass kinds: ['observer','enricher','meeting_sync','topic_resonance'].",
    );
  }
  const w = unwrapConfig(config);
  if (w.error) return { error: w.error };
  const { url, key } = w.config;
  const target = joinUrl(url, "/jobs/claim");
  let res;
  try {
    res = await fetchImpl(target, {
      method: "POST",
      headers: authHeaders(key),
      body: JSON.stringify({ agent, kinds }),
    });
  } catch (e) {
    return networkError(e);
  }
  const body = await readBody(res);
  if (!res.ok) return httpError(res, body);
  return body;
}

/**
 * POST /jobs/report — Phase 5 prereq. Reports a job's outcome.
 *
 * params.job_id: required.
 * params.status: "succeeded" | "failed" | "retry".
 * params.result: optional result object.
 * params.error: optional error string (when status != succeeded).
 */
export async function orbitJobsReport(
  { job_id, status, result, error } = {},
  { config, fetchImpl = fetch } = {},
) {
  if (!job_id || typeof job_id !== "string") {
    return invalidInputError(
      "job_id (string) is required",
      "Pass {job_id: '<id>', status: 'succeeded'|'failed'|'retry'}.",
    );
  }
  if (!status || typeof status !== "string") {
    return invalidInputError(
      "status (string) is required",
      "Pass status: 'succeeded' | 'failed' | 'retry'.",
    );
  }
  const allowed = new Set(["succeeded", "failed", "retry"]);
  if (!allowed.has(status)) {
    return invalidInputError(
      `status='${status}' is not one of: succeeded, failed, retry`,
      "Use one of the three canonical terminal states.",
    );
  }
  const w = unwrapConfig(config);
  if (w.error) return { error: w.error };
  const { url, key } = w.config;
  const target = joinUrl(url, "/jobs/report");
  let res;
  try {
    res = await fetchImpl(target, {
      method: "POST",
      headers: authHeaders(key),
      body: JSON.stringify({
        job_id,
        status,
        result: result ?? null,
        error: error ?? null,
      }),
    });
  } catch (e) {
    return networkError(e);
  }
  const body = await readBody(res);
  if (!res.ok) return httpError(res, body);
  return body;
}

/**
 * POST /lid_bridge/upsert — bulk-upsert LID→phone bridge entries (projected
 * from claw's whatsmeow_lid_map table into Postgres so graph-populate can
 * resolve group-message `@lid` senders back to persons).
 *
 * params.entries: array of {lid: string, phone: string, last_seen?: ISO8601}.
 *                 Max 1000 entries per call (server cap).
 *
 * Returns {upserted: N} on 2xx. The CLI does a minimal pre-check
 * (non-empty array, <= 1000 entries); full shape validation is server-side.
 */
export async function orbitLidBridgeUpsert(
  { entries } = {},
  { config, fetchImpl = fetch } = {},
) {
  if (!Array.isArray(entries)) {
    return invalidInputError(
      "entries (array) is required",
      "Pass {entries: [{lid: '<digits>', phone: '<digits>', last_seen?: '<ISO>'}]}.",
    );
  }
  if (entries.length === 0) {
    return invalidInputError(
      "entries array is empty",
      "Pass at least one bridge entry; empty batches are rejected server-side.",
    );
  }
  if (entries.length > 1000) {
    return invalidInputError(
      `entries batch size ${entries.length} exceeds server cap of 1000`,
      "Split the batch into chunks of at most 1000 entries.",
    );
  }
  const w = unwrapConfig(config);
  if (w.error) return { error: w.error };
  const { url, key } = w.config;
  const target = joinUrl(url, "/lid_bridge/upsert");
  let res;
  try {
    res = await fetchImpl(target, {
      method: "POST",
      headers: authHeaders(key),
      body: JSON.stringify({ entries }),
    });
  } catch (e) {
    return networkError(e);
  }
  const body = await readBody(res);
  if (!res.ok) return httpError(res, body);
  return body;
}

// -------------------------------------------------------------------------
// Onboarding backfill verbs (Phase A — first-run data-seeding on claw).
//
// These three verbs replace the legacy `scripts/*.mjs` backfill flow:
//   orbit_raw_events_backfill_from_wacli  (was: fast-copy-wacli-to-raw-events.mjs)
//   orbit_interactions_backfill           (was: build-interactions-from-raw-events.mjs)
//   orbit_lid_bridge_ingest               (was: populate-lid-bridge.mjs)
//
// They are invoked from the `orbit-observer-backfill` SKILL on a new
// founder's claw. Pure plumbing — no LLM, no direct-DB writes. Every
// write goes through the HTTP API (CLAUDE.md §6: "API is the only
// writer"). No SSH required; the skill runs on claw, reads local files
// (~/.wacli/wacli.db, ~/.wacli/session.db), and POSTs up.
// -------------------------------------------------------------------------

// Shared: UTF-8 sanitizer for WhatsApp text. Postgres TEXT/JSONB reject
// NULs and unpaired UTF-16 surrogates — strip both before writing.
// Ported from scripts/fast-copy-wacli-to-raw-events.mjs (which this
// replaces).
function cleanString(s) {
  if (s == null) return null;
  return String(s)
    .replace(/\u0000/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
    .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "$1");
}

function safeSlice(s, n) {
  if (s == null) return null;
  const arr = Array.from(String(s));
  return arr.slice(0, n).join("");
}

// Shared: transform wacli.db rows into raw_events batch schema.
// Pure function — tested in isolation. Same mapping the legacy script
// used; staying bit-for-bit identical keeps re-ingest idempotent.
export function wacliRowsToRawEvents(
  rows,
  { connectorVersion = "wacli-backfill-0.4-cli" } = {},
) {
  const out = [];
  for (const r of rows) {
    const eventId = `${r.chat_jid}|${r.msg_id}`;
    const body = r.text || r.display_text || r.media_caption || null;
    const direction = r.from_me === 1 ? "out" : "in";
    const occurredAt = new Date(Number(r.ts) * 1000).toISOString();
    const phone =
      r.sender_jid && /^\d+@s\.whatsapp\.net$/.test(r.sender_jid)
        ? "+" + r.sender_jid.split("@")[0]
        : null;
    const participantsRaw =
      r.sender_jid && r.sender_jid !== "self"
        ? [{ jid: r.sender_jid, name: cleanString(r.sender_name) }]
        : [];
    out.push({
      source: "whatsapp",
      source_event_id: eventId,
      channel: "whatsapp",
      connector_version: connectorVersion,
      occurred_at: occurredAt,
      direction,
      thread_id: r.chat_jid,
      participants_raw: participantsRaw,
      participant_phones: phone ? [phone] : [],
      participant_emails: [],
      body_preview: safeSlice(cleanString(body), 160),
      attachments_present: Boolean(r.media_type),
      raw_ref: {
        chat_name: cleanString(r.chat_name),
        kind: r.kind ?? "unknown",
        msg_id: r.msg_id,
      },
    });
  }
  return out;
}

async function loadSqliteImpl(injected) {
  if (injected) return injected;
  try {
    const mod = await import("better-sqlite3");
    return mod.default ?? mod;
  } catch (e) {
    return null;
  }
}

/**
 * orbit_raw_events_backfill_from_wacli
 *
 * One-shot onboarding verb. Reads the founder's local ~/.wacli/wacli.db,
 * projects every row into a raw_events envelope, chunks into batches of
 * 500, POSTs each chunk to /api/v1/raw_events. Idempotent on
 * (user_id, source, source_event_id) — re-running is safe.
 *
 * params.wacli_db?     override path (default ~/.wacli/wacli.db).
 * params.batch_size?   default 500, max 500 (server cap).
 * params.connector_version? default "wacli-backfill-0.4-cli".
 * params.dry_run?      if true, do the SQLite read + shape validation
 *                      but skip POSTs. Returns {ok, dry_run:true, count}.
 *
 * Returns {ok, batches_posted, total_rows, total_inserted, total_updated,
 *          failed_batches[]} on success, {error:{...}} on validation /
 * local failure.
 */
export async function orbitRawEventsBackfillFromWacli(
  {
    wacli_db,
    batch_size = 500,
    connector_version,
    dry_run = false,
    sqliteImpl,
  } = {},
  { config, fetchImpl = fetch } = {},
) {
  const path = wacli_db || `${process.env.HOME}/.wacli/wacli.db`;
  if (!existsSync(path)) {
    return fileNotFoundError(path);
  }
  if (!Number.isFinite(batch_size) || batch_size <= 0 || batch_size > 500) {
    return invalidInputError(
      `batch_size=${batch_size} out of range (1..500)`,
      "Server cap is 500 rows per /raw_events batch. Use a smaller size.",
    );
  }

  const Database = await loadSqliteImpl(sqliteImpl);
  if (!Database) {
    return {
      error: {
        code: "VALIDATION_FAILED",
        message: "better-sqlite3 not available in this runtime",
        suggestion:
          "Install better-sqlite3 in the gateway node_modules on claw, then retry.",
      },
    };
  }

  const db = new Database(path, { readonly: true });
  let rows;
  try {
    rows = db
      .prepare(
        `SELECT m.chat_jid, m.msg_id, m.sender_jid, m.sender_name, m.ts,
                m.from_me, m.text, m.display_text, m.media_caption,
                m.media_type, c.kind, m.chat_name
           FROM messages m
      LEFT JOIN chats c ON c.jid = m.chat_jid
           ORDER BY m.ts`,
      )
      .all();
  } finally {
    db.close();
  }

  const events = wacliRowsToRawEvents(rows, {
    connectorVersion: connector_version,
  });

  if (dry_run) {
    return {
      ok: true,
      dry_run: true,
      count: events.length,
    };
  }

  if (events.length === 0) {
    return {
      ok: true,
      batches_posted: 0,
      total_rows: 0,
      total_inserted: 0,
      total_updated: 0,
      failed_batches: [],
    };
  }

  const w = unwrapConfig(config);
  if (w.error) return { error: w.error };
  const { url, key } = w.config;
  const target = joinUrl(url, "/raw_events");

  let total_inserted = 0;
  let total_updated = 0;
  let batches_posted = 0;
  const failed_batches = [];

  for (let i = 0; i < events.length; i += batch_size) {
    const batch = events.slice(i, i + batch_size);
    batches_posted += 1;
    let res;
    try {
      res = await fetchImpl(target, {
        method: "POST",
        headers: authHeaders(key),
        body: JSON.stringify(batch),
      });
    } catch (e) {
      const err = networkError(e).error;
      failed_batches.push({ batch_index: i / batch_size, http_status: 0, error: err });
      continue;
    }
    const body = await readBody(res);
    if (!res.ok) {
      const err = httpError(res, body).error;
      failed_batches.push({
        batch_index: i / batch_size,
        http_status: res.status,
        error: err,
      });
      continue;
    }
    total_inserted += body.inserted ?? 0;
    total_updated += body.updated ?? 0;
  }

  return {
    ok: true,
    batches_posted,
    total_rows: events.length,
    total_inserted,
    total_updated,
    failed_batches,
  };
}

/**
 * orbit_lid_bridge_ingest
 *
 * Reads the founder's local ~/.wacli/session.db whatsmeow_lid_map
 * (lid, pn) rows, chunks into batches of ≤1000, POSTs each chunk to
 * /api/v1/lid_bridge/upsert. Idempotent on (user_id, lid).
 *
 * Replaces scripts/populate-lid-bridge.mjs, which used to SSH from the
 * founder's Mac to claw, shell out to sqlite3, and POST. The new verb
 * runs ON claw (same host as session.db) so no SSH is required — the
 * observer-backfill SKILL invokes it directly.
 *
 * params.session_db?  override path (default ~/.wacli/session.db).
 * params.batch_size?  default 500, max 1000 (server cap).
 *
 * Returns {ok, rows_dumped, batches_posted, total_upserted, failed_batches[]}.
 */
export async function orbitLidBridgeIngest(
  {
    session_db,
    batch_size = 500,
    sqliteImpl,
  } = {},
  { config, fetchImpl = fetch } = {},
) {
  const path = session_db || `${process.env.HOME}/.wacli/session.db`;
  if (!existsSync(path)) {
    return fileNotFoundError(path);
  }
  if (!Number.isFinite(batch_size) || batch_size <= 0 || batch_size > 1000) {
    return invalidInputError(
      `batch_size=${batch_size} out of range (1..1000)`,
      "Server cap is 1000 entries per /lid_bridge/upsert batch.",
    );
  }

  const Database = await loadSqliteImpl(sqliteImpl);
  if (!Database) {
    return {
      error: {
        code: "VALIDATION_FAILED",
        message: "better-sqlite3 not available in this runtime",
        suggestion:
          "Install better-sqlite3 in the gateway node_modules on claw, then retry.",
      },
    };
  }

  const db = new Database(path, { readonly: true });
  const entries = [];
  try {
    const rows = db
      .prepare("SELECT lid, pn FROM whatsmeow_lid_map")
      .all();
    for (const r of rows) {
      const lid = String(r.lid ?? "").trim().split(":")[0];
      const phone = String(r.pn ?? "").trim().replace(/\D+/g, "");
      if (!lid || !phone) continue;
      entries.push({ lid, phone });
    }
  } finally {
    db.close();
  }

  if (entries.length === 0) {
    return {
      ok: true,
      rows_dumped: 0,
      batches_posted: 0,
      total_upserted: 0,
      failed_batches: [],
    };
  }

  const w = unwrapConfig(config);
  if (w.error) return { error: w.error };
  const { url, key } = w.config;
  const target = joinUrl(url, "/lid_bridge/upsert");

  let total_upserted = 0;
  let batches_posted = 0;
  const failed_batches = [];

  for (let i = 0; i < entries.length; i += batch_size) {
    const batch = entries.slice(i, i + batch_size);
    batches_posted += 1;
    let res;
    try {
      res = await fetchImpl(target, {
        method: "POST",
        headers: authHeaders(key),
        body: JSON.stringify({ entries: batch }),
      });
    } catch (e) {
      const err = networkError(e).error;
      failed_batches.push({ batch_index: i / batch_size, http_status: 0, error: err });
      continue;
    }
    const body = await readBody(res);
    if (!res.ok) {
      const err = httpError(res, body).error;
      failed_batches.push({
        batch_index: i / batch_size,
        http_status: res.status,
        error: err,
      });
      continue;
    }
    total_upserted += body.upserted ?? 0;
  }

  return {
    ok: true,
    rows_dumped: entries.length,
    batches_posted,
    total_upserted,
    failed_batches,
  };
}

/**
 * orbit_interactions_backfill
 *
 * Paginates GET /api/v1/raw_events?source=whatsapp, projects each row
 * into a kind:"interaction" observation, and POSTs them in chunks via
 * /api/v1/observations. Deduplication is enforced server-side via
 * observations.dedup_key (SHA-256 over kind + evidence_pointer).
 *
 * Replaces scripts/build-interactions-from-raw-events.mjs. Key
 * differences:
 *   - Reads raw_events via HTTP (never direct Postgres).
 *   - Does NOT resolve phone → person_id; the resolver SKILL handles
 *     merges downstream via kind:"merge" observations. This verb emits
 *     only kind:"interaction" envelopes; phone/LID bridging is an
 *     orthogonal step.
 *   - Batched 100 observations/POST. Server dedupes on re-runs.
 *
 * params.source?      default "whatsapp". Only whatsapp is implemented for V0.
 * params.limit?       per-page limit (default 500, server max 1000).
 * params.batch_size?  observations per POST (default 100, server max 100).
 * params.max_pages?   circuit breaker (default 500 pages → 500k rows).
 * params.self_name?   display name for participants[0] (default "Founder").
 * params.dry_run?     if true, count only — no POSTs.
 *
 * Returns {ok, pages_scanned, rows_scanned, observations_posted,
 *          total_inserted, total_deduped, failed_batches[]}.
 */
export async function orbitInteractionsBackfill(
  {
    source = "whatsapp",
    limit = 500,
    batch_size = 100,
    max_pages = 500,
    self_name = "Founder",
    dry_run = false,
  } = {},
  { config, fetchImpl = fetch } = {},
) {
  if (source !== "whatsapp") {
    return invalidInputError(
      `source='${source}' not supported in V0; only 'whatsapp'`,
      "V0 projects WhatsApp raw_events into interactions. Gmail/calendar backfill is tracked for future work.",
    );
  }
  if (!Number.isFinite(limit) || limit <= 0 || limit > 1000) {
    return invalidInputError(
      `limit=${limit} out of range (1..1000)`,
      "Server cap is 1000 rows per /raw_events page. Use a smaller limit.",
    );
  }
  if (!Number.isFinite(batch_size) || batch_size <= 0 || batch_size > 100) {
    return invalidInputError(
      `batch_size=${batch_size} out of range (1..100)`,
      "Server cap is 100 observations per /observations batch.",
    );
  }

  const w = unwrapConfig(config);
  if (w.error) return { error: w.error };
  const { url, key } = w.config;

  const pageUrl = (cursor) => {
    const qs = new URLSearchParams();
    qs.set("source", source);
    qs.set("limit", String(limit));
    if (cursor) qs.set("cursor", cursor);
    return joinUrl(url, `/raw_events?${qs.toString()}`);
  };

  const obsUrl = joinUrl(url, "/observations");

  let cursor = null;
  let pages_scanned = 0;
  let rows_scanned = 0;
  let observations_posted = 0;
  let total_inserted = 0;
  let total_deduped = 0;
  const failed_batches = [];
  let pending = [];

  async function flush() {
    if (pending.length === 0) return;
    if (dry_run) {
      observations_posted += pending.length;
      pending = [];
      return;
    }
    const payload = pending;
    pending = [];
    let res;
    try {
      res = await fetchImpl(obsUrl, {
        method: "POST",
        headers: authHeaders(key),
        body: JSON.stringify(payload),
      });
    } catch (e) {
      const err = networkError(e).error;
      failed_batches.push({ http_status: 0, error: err, size: payload.length });
      return;
    }
    const body = await readBody(res);
    if (!res.ok) {
      const err = httpError(res, body).error;
      failed_batches.push({
        http_status: res.status,
        error: err,
        size: payload.length,
      });
      return;
    }
    observations_posted += payload.length;
    total_inserted += body.inserted ?? 0;
    total_deduped += body.deduped ?? 0;
  }

  for (let page = 0; page < max_pages; page += 1) {
    let res;
    try {
      res = await fetchImpl(pageUrl(cursor), {
        method: "GET",
        headers: authHeaders(key),
      });
    } catch (e) {
      return networkError(e);
    }
    const body = await readBody(res);
    if (!res.ok) return httpError(res, body);

    const events = Array.isArray(body?.events) ? body.events : [];
    pages_scanned += 1;
    rows_scanned += events.length;

    for (const ev of events) {
      const obs = rawEventToInteractionObservation(ev, { self_name });
      if (!obs) continue;
      pending.push(obs);
      if (pending.length >= batch_size) {
        await flush();
      }
    }

    if (!body?.next_cursor) break;
    cursor = body.next_cursor;
  }

  await flush();

  return {
    ok: true,
    pages_scanned,
    rows_scanned,
    observations_posted,
    total_inserted,
    total_deduped,
    failed_batches,
    ...(dry_run ? { dry_run: true } : {}),
  };
}

/**
 * Project one raw_events row into a kind:"interaction" observation.
 * Returns null for rows that can't be projected (missing phone,
 * group-kind, self-only, etc.). Deterministic — no LLM, no network.
 * The resolver SKILL handles merge + person_id resolution downstream.
 */
export function rawEventToInteractionObservation(row, { self_name } = {}) {
  if (!row || typeof row !== "object") return null;
  const occurred = row.occurred_at;
  if (!occurred) return null;
  const kind = row.raw_ref?.kind;
  // Group-message rows have sender collapsed into chat_jid; skip —
  // a dedicated group-participant pipeline is future work.
  if (kind === "group") return null;
  const phones = Array.isArray(row.participant_phones)
    ? row.participant_phones.filter(Boolean)
    : [];
  if (phones.length === 0) return null;
  const peerPhone = String(phones[0]).trim();
  if (!peerPhone) return null;

  const peerRaw = Array.isArray(row.participants_raw) ? row.participants_raw[0] : null;
  const peerName =
    peerRaw && typeof peerRaw === "object" && typeof peerRaw.name === "string"
      ? peerRaw.name.trim()
      : "";
  const safePeerName = peerName && peerName.toLowerCase() !== "me" ? peerName : peerPhone;

  const direction = row.direction === "out" ? "out" : "in";
  const bodyPreview = typeof row.body_preview === "string"
    ? row.body_preview.trim()
    : "";
  const summary =
    (direction === "out" ? "Outbound" : "Inbound") +
    ` WhatsApp message: ${bodyPreview || "(no preview)"}`;

  return {
    kind: "interaction",
    observed_at: new Date(occurred).toISOString(),
    observer: "wazowski",
    evidence_pointer: `wacli://messages/source_event_id=${row.source_event_id}`,
    confidence: 1.0,
    reasoning:
      `Deterministic projection of raw_events row (source=whatsapp, ` +
      `direction=${direction}, thread_id=${row.thread_id ?? "null"}). ` +
      `Peer phone ${peerPhone} — resolver will attach to a person via the ` +
      `phone bridge.`.slice(0, 2000),
    payload: {
      participants: [
        String(self_name || "Founder").slice(0, 256),
        String(safePeerName).slice(0, 256),
      ],
      channel: "whatsapp",
      summary: summary.slice(0, 2000),
      topic: "business",
      relationship_context: "",
      connection_context: "",
      sentiment: "neutral",
    },
  };
}

/**
 * POST /person/:id/snapshots — write ONE immutable per-pass card snapshot.
 * Called by enricher/resolver/correction SKILLs at pass boundary, and by
 * the combiner SKILL when writing pass_kind='summary'.
 *
 * Returns {ok, id} on success, {error:{...}} on failure.
 */
export async function orbitPersonSnapshotWrite(
  {
    person_id,
    pass_kind,
    card_state,
    evidence_pointer_ids,
    diff_summary,
    confidence_delta,
  } = {},
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
  const VALID_KINDS = new Set(["enricher", "resolver", "summary", "correction"]);
  if (!pass_kind || !VALID_KINDS.has(pass_kind)) {
    return invalidInputError(
      "pass_kind must be one of: enricher, resolver, summary, correction",
      `Got: ${JSON.stringify(pass_kind)}.`,
    );
  }

  const cfg = config ?? resolveConfig();
  const effective =
    cfg && typeof cfg === "object" && "ok" in cfg
      ? cfg.ok
        ? cfg.config
        : null
      : cfg;
  if (!effective) {
    return invalidInputError(
      "ORBIT_API_BASE / ORBIT_API_KEY must be set",
      "Check the gateway env before calling orbit_person_snapshot_write.",
    );
  }
  const { url, key } = effective;

  const body = {
    pass_kind,
    card_state: card_state ?? {},
    evidence_pointer_ids: Array.isArray(evidence_pointer_ids)
      ? evidence_pointer_ids
      : [],
    diff_summary: typeof diff_summary === "string" ? diff_summary : "",
    confidence_delta: confidence_delta ?? {},
  };

  const target = joinUrl(url, `/person/${person_id}/snapshots`);
  let res;
  try {
    res = await fetchImpl(target, {
      method: "POST",
      headers: authHeaders(key),
      body: JSON.stringify(body),
    });
  } catch (e) {
    return networkError(e);
  }
  const respBody = await readBody(res);
  if (!res.ok) return httpError(res, respBody);
  return respBody;
}

/**
 * GET /person/:id/snapshots?limit=N — list newest-first snapshots for a
 * person. Used by the UI Evolution stack.
 *
 * Returns {snapshots:[...], total} on success, {error:{...}} on failure.
 */
export async function orbitPersonSnapshotsList(
  { person_id, limit } = {},
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

  const cfg = config ?? resolveConfig();
  const effective =
    cfg && typeof cfg === "object" && "ok" in cfg
      ? cfg.ok
        ? cfg.config
        : null
      : cfg;
  if (!effective) {
    return invalidInputError(
      "ORBIT_API_BASE / ORBIT_API_KEY must be set",
      "Check the gateway env before calling orbit_person_snapshots_list.",
    );
  }
  const { url, key } = effective;

  const qs = new URLSearchParams();
  if (limit) qs.set("limit", String(limit));
  const q = qs.toString();
  const target = joinUrl(url, `/person/${person_id}/snapshots${q ? `?${q}` : ""}`);

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
  return body;
}

// Exported for tests.
export const __test = { joinUrl, runChild };
