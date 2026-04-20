// Validate every generated merge against the client-side Zod schema the
// CLI plugin will use. Fail-fast catches schema drift without a round-trip.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const { observationSchema } = await import(
  path.join(ROOT, "orbit-cli-plugin/lib/schema.mjs")
);

const file = path.join(__dirname, "merges.ndjson");
const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.length);

let ok = 0;
const failures = [];
for (let i = 0; i < lines.length; i++) {
  try {
    const obj = JSON.parse(lines[i]);
    const parsed = observationSchema.safeParse(obj);
    if (parsed.success) {
      ok++;
    } else {
      failures.push({ line: i + 1, issues: parsed.error.issues });
      if (failures.length > 5) break;
    }
  } catch (e) {
    failures.push({ line: i + 1, parse_error: String(e) });
    if (failures.length > 5) break;
  }
}

console.log(JSON.stringify({ total: lines.length, ok, failures_head: failures.slice(0, 5) }, null, 2));
if (failures.length) process.exitCode = 1;
