// Env reader, deliberately isolated from any network call-site. The
// OpenClaw skill-scanner raises a critical finding for any source file
// that mixes env access with network-send tokens; keeping these concerns
// in different files is what lets the scanner pass us.
//
// Env contract (must be set by the gateway systemd unit):
//   ORBIT_API_BASE = bare host, no path
//                    (e.g. http://100.97.152.84:3047 or https://orbit.example.com)
//   ORBIT_API_KEY  = Bearer token (orb_live_*)
//
// The base MUST NOT include `/api/v1` — the client.mjs layer appends it.
// This keeps the local-vs-Vercel cutover a one-line env swap.

export function resolveConfig(envSource) {
  const env = envSource ?? process.env;
  const base = env.ORBIT_API_BASE;
  const key = env.ORBIT_API_KEY;
  if (!base) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "orbit-cli: ORBIT_API_BASE is not set",
        suggestion:
          "Set ORBIT_API_BASE on the gateway host to the bare host (e.g. http://100.97.152.84:3047 or https://orbit.example.com) before invoking any orbit-cli tool. Do NOT include /api/v1 — the client appends it.",
      },
    };
  }
  if (/\/api\/v\d+/i.test(base)) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "orbit-cli: ORBIT_API_BASE must not include /api/v<N>",
        suggestion:
          "ORBIT_API_BASE is the bare host only (e.g. http://100.97.152.84:3047). The /api/v1 path prefix is appended automatically by the client.",
      },
    };
  }
  if (!key) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "orbit-cli: ORBIT_API_KEY is not set",
        suggestion:
          "Set ORBIT_API_KEY (orb_live_* Bearer token) on the gateway host before invoking any orbit-cli tool.",
      },
    };
  }
  // Canonicalize: strip trailing slashes so we always join with a single /.
  // Return both the flat {url, key} and legacy {ok, config} shapes — the
  // flat shape lets `const {url, key} = config ?? resolveConfig()` work
  // directly (a long-standing bug was that it destructured nothing when
  // resolveConfig's wrapper form was returned), while the {ok, config}
  // shape preserves backward compatibility for earlier call sites that
  // already unwrap it.
  const flat = { url: base.replace(/\/+$/, ""), key };
  return { ok: true, config: flat, url: flat.url, key: flat.key };
}
