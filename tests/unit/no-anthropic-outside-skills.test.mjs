// Regression test: no Anthropic / Claude-model references outside
// orbit-claw-skills/**.
//
// Invariant (memory: project_cli_is_plumbing.md, CLAUDE.md §7):
//   - scripts/*.mjs        — no LLM calls
//   - orbit-cli-plugin/**  — no LLM calls
//   - src/**               — no LLM calls (the Next.js app is pure HTTP)
//   - orbit-rules-plugin/** — no LLM calls (deterministic rules only)
//
// LLM calls belong ONLY in orbit-claw-skills/**/SKILL.md — the observer
// runtime reads the SKILL and funds Anthropic from the founder's own
// token budget. If this test fails, it means someone reintroduced a
// Node-script or API-route Anthropic call — which burns the developer's
// token (wrong budget) and couples the app to an LLM provider (wrong
// layer).
//
// The test greps for:
//   - /anthropic/i
//   - /claude-sonnet|claude-haiku|claude-opus/
//   - imports of @anthropic-ai/sdk
//
// under the four forbidden trees. Any match is a fail.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");

// The trees we scan. If you add a new tree that should stay
// LLM-free, add it here.
const FORBIDDEN_ROOTS = [
  "scripts",
  "orbit-cli-plugin",
  "src",
  "orbit-rules-plugin",
];

// Directories inside those roots that should be skipped (third-party,
// build artifacts).
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  "build",
  ".turbo",
  "coverage",
  ".vercel",
]);

// Extensions to scan. Keep tight so we don't churn on lockfiles /
// binary fixtures.
const SCAN_EXTS = new Set([".mjs", ".js", ".ts", ".tsx", ".jsx"]);

// Patterns that flag an Anthropic / Claude-model usage. Exact-match
// model names (not just "claude" so we don't false-positive on
// things like "claw" / general prose).
const PATTERNS = [
  /\banthropic\b/i,
  /claude-(sonnet|haiku|opus)/i,
  /@anthropic-ai\/sdk/,
];

function walk(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, acc);
      continue;
    }
    if (!e.isFile()) continue;
    const dotIdx = e.name.lastIndexOf(".");
    const ext = dotIdx >= 0 ? e.name.slice(dotIdx) : "";
    if (!SCAN_EXTS.has(ext)) continue;
    acc.push(full);
  }
}

function findMatches(path) {
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const hits = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    for (const p of PATTERNS) {
      if (p.test(lines[i])) {
        hits.push({ line: i + 1, text: lines[i].slice(0, 200), pattern: p.source });
      }
    }
  }
  return hits;
}

describe("no Anthropic / Claude-model references outside orbit-claw-skills/**", () => {
  for (const rootName of FORBIDDEN_ROOTS) {
    it(`${rootName}/** has no Anthropic references`, () => {
      const root = resolve(REPO_ROOT, rootName);
      let stat;
      try {
        stat = statSync(root);
      } catch {
        // Tree absent — vacuously true.
        return;
      }
      if (!stat.isDirectory()) return;

      const files = [];
      walk(root, files);

      const violations = [];
      for (const f of files) {
        // Skip THIS test file itself — it intentionally mentions the
        // forbidden strings as test data.
        if (f === __filename) continue;
        const hits = findMatches(f);
        for (const h of hits) {
          violations.push({
            file: f.replace(REPO_ROOT + "/", ""),
            line: h.line,
            pattern: h.pattern,
            snippet: h.text,
          });
        }
      }

      if (violations.length > 0) {
        // Print the first 10 so failures are debuggable without
        // drowning the console.
        const preview = violations.slice(0, 10).map(
          (v) => `  ${v.file}:${v.line}  [${v.pattern}]  ${v.snippet}`,
        );
        throw new Error(
          `Found ${violations.length} Anthropic/Claude-model reference(s) under ${rootName}/. ` +
            `LLM calls belong only in orbit-claw-skills/**/SKILL.md.\n\n` +
            preview.join("\n") +
            (violations.length > 10 ? `\n  … +${violations.length - 10} more` : ""),
        );
      }

      expect(violations).toHaveLength(0);
    });
  }
});
