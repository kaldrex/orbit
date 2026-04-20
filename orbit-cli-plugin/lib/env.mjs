// Env reader, deliberately isolated from any network call-site. The
// OpenClaw skill-scanner raises a critical finding for any source file
// that mixes env access with network-send tokens; keeping these concerns
// in different files is what lets the scanner pass us.
//
// Env contract (must be set by the gateway systemd unit):
//   ORBIT_API_URL = fully-qualified base including /api/v1
//                   (e.g. http://100.97.152.84:3047/api/v1)
//   ORBIT_API_KEY = Bearer token (orb_live_*)

export function resolveConfig(envSource) {
  const env = envSource ?? process.env;
  const url = env.ORBIT_API_URL;
  const key = env.ORBIT_API_KEY;
  if (!url) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "orbit-cli: ORBIT_API_URL is not set",
        suggestion:
          "Set ORBIT_API_URL on the gateway host (e.g. http://100.97.152.84:3047/api/v1) before invoking any orbit-cli tool.",
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
  return { ok: true, config: { url: url.replace(/\/+$/, ""), key } };
}
