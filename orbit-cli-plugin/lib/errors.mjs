// Stable error-code taxonomy for orbit-cli. The agent pattern-matches on
// `code` (not message prose). Every error result returned by client.mjs
// conforms to this shape:
//
//   { error: {
//       code: <one of ERROR_CODES>,
//       message: <short human sentence>,
//       suggestion: <one-liner the agent can surface to a user>,
//       body_preview?: <first 500 chars of the HTTP body, if any>,
//       details?: [{field, reason}],
//     }
//   }
//
// No stack traces, no free-form text — this is machine-readable plumbing.

export const ERROR_CODES = Object.freeze({
  VALIDATION_FAILED: "VALIDATION_FAILED",
  AUTH_FAILED: "AUTH_FAILED",
  NOT_FOUND: "NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  SERVER_ERROR: "SERVER_ERROR",
  NETWORK_ERROR: "NETWORK_ERROR",
  INVALID_UUID: "INVALID_UUID",
  MAX_BATCH_EXCEEDED: "MAX_BATCH_EXCEEDED",
  FILE_NOT_FOUND: "FILE_NOT_FOUND",
  EMPTY_FILE: "EMPTY_FILE",
  // Non-fatal-but-out-of-taxonomy fallbacks:
  BAD_REQUEST: "BAD_REQUEST", // 400 not caught by local validation
  INVALID_INPUT: "INVALID_INPUT", // caller passed wrong shape to the CLI itself
});

/**
 * Shape a zod error into {code, message, suggestion, details[]}.
 * `details` preserves per-field reasons so the agent can re-prompt precisely.
 */
export function validationError(zodError, { suggestion } = {}) {
  const issues = zodError?.issues ?? [];
  const details = issues.slice(0, 20).map((i) => ({
    field: Array.isArray(i.path) ? i.path.join(".") : String(i.path ?? ""),
    reason: i.message ?? "invalid",
  }));
  return {
    error: {
      code: ERROR_CODES.VALIDATION_FAILED,
      message: `observation failed schema validation (${issues.length} issue${issues.length === 1 ? "" : "s"})`,
      suggestion:
        suggestion ??
        "Fix the fields listed in `details`. Enum fields must match exactly; phones should be E.164 like +971586783040; observed_at needs a timezone offset.",
      details,
    },
  };
}

/**
 * Map an HTTP status → error code. Kept narrow so the taxonomy stays small.
 */
function codeForStatus(status) {
  if (status === 401 || status === 403) return ERROR_CODES.AUTH_FAILED;
  if (status === 404) return ERROR_CODES.NOT_FOUND;
  if (status === 429) return ERROR_CODES.RATE_LIMITED;
  if (status === 400) return ERROR_CODES.BAD_REQUEST;
  if (status >= 500) return ERROR_CODES.SERVER_ERROR;
  return ERROR_CODES.BAD_REQUEST;
}

function suggestionForCode(code) {
  switch (code) {
    case ERROR_CODES.AUTH_FAILED:
      return "Check ORBIT_API_KEY on the gateway host — the token is missing, expired, or revoked.";
    case ERROR_CODES.NOT_FOUND:
      return "Confirm the person_id exists. Resolve via search first, then retry the card fetch.";
    case ERROR_CODES.RATE_LIMITED:
      return "Back off and retry after 60s. If persistent, reduce batch rate or contact Orbit ops.";
    case ERROR_CODES.SERVER_ERROR:
      return "Orbit returned a 5xx. Inspect server logs before retrying; do not blind-retry (log-first, retry-never).";
    case ERROR_CODES.BAD_REQUEST:
      return "The server rejected the request body. Inspect body_preview for the server's reason; likely a schema field the local validator accepts but the server rejects.";
    default:
      return "Inspect body_preview for the server's explanation.";
  }
}

/**
 * Shape an HTTP error response from fetch() into the canonical envelope.
 */
export function httpError(res, body) {
  const code = codeForStatus(res.status);
  const bodyStr =
    typeof body === "object" ? JSON.stringify(body) : String(body ?? "");
  return {
    error: {
      code,
      message:
        body?.error ??
        res.statusText ??
        `HTTP ${res.status}`,
      suggestion: suggestionForCode(code),
      body_preview: bodyStr.slice(0, 500),
      http_status: res.status,
    },
  };
}

/**
 * Shape a thrown fetch() exception (DNS failure, ECONNREFUSED, timeout, …)
 * into the canonical envelope.
 */
export function networkError(e) {
  return {
    error: {
      code: ERROR_CODES.NETWORK_ERROR,
      message: `fetch failed: ${e?.message ?? String(e)}`,
      suggestion:
        "Check connectivity to ORBIT_API_BASE (DNS, Tailscale, port 3047). The Orbit server may be down or the tailnet may be detached.",
    },
  };
}

export function invalidUuidError(value) {
  return {
    error: {
      code: ERROR_CODES.INVALID_UUID,
      message: `person_id is not a valid UUID: ${value}`,
      suggestion:
        "person_id must be a 36-character hex-with-dashes UUID (e.g., 67050b91-5011-4ba6-b230-9a387879717a).",
    },
  };
}

export function maxBatchExceededError(size, max) {
  return {
    error: {
      code: ERROR_CODES.MAX_BATCH_EXCEEDED,
      message: `batch size ${size} exceeds MAX_BATCH=${max}`,
      suggestion: `Split the batch into chunks of at most ${max} observations. Use orbit_observation_bulk for large files — it chunks automatically.`,
    },
  };
}

export function fileNotFoundError(path) {
  return {
    error: {
      code: ERROR_CODES.FILE_NOT_FOUND,
      message: `file not found: ${path}`,
      suggestion:
        "Confirm the path is absolute and readable by the gateway process. Remember: the plugin runs on claw — the path must exist on claw's filesystem, not your Mac.",
    },
  };
}

export function emptyFileError(path) {
  return {
    error: {
      code: ERROR_CODES.EMPTY_FILE,
      message: `file has zero non-blank lines: ${path}`,
      suggestion:
        "The NDJSON file is empty or contains only whitespace. Re-generate the observations before calling bulk.",
    },
  };
}

export function invalidInputError(message, suggestion) {
  return {
    error: {
      code: ERROR_CODES.INVALID_INPUT,
      message,
      suggestion:
        suggestion ??
        "Check the shape of the parameters you passed to the CLI tool.",
    },
  };
}
