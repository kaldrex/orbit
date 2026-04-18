// Resolves the absolute path to the `gws` CLI. The gateway subprocess
// launches connectors with a stripped PATH, so `which gws` misses even
// when gws is installed. Probe a fixed candidate list first, then fall
// back to PATH-based lookup.

import { existsSync as fsExistsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const CANDIDATES = () => [
  "/usr/local/bin/gws",
  "/usr/bin/gws",
  "/opt/homebrew/bin/gws",
  join(homedir(), ".local", "bin", "gws"),
  join(homedir(), "bin", "gws"),
];

function defaultWhich() {
  try {
    const out = execFileSync("which", ["gws"], { encoding: "utf8" }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * @param {{ existsSync?: (p: string) => boolean, which?: () => string | null }} [deps]
 * @returns {string | null}
 */
export function resolveGwsPath(deps = {}) {
  const existsSyncFn = deps.existsSync || fsExistsSync;
  const which = deps.which || defaultWhich;
  for (const p of CANDIDATES()) {
    if (existsSyncFn(p)) return p;
  }
  return which();
}
