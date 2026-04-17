#!/usr/bin/env node
// Driver for the identity resolver against the live Orbit HTTP API.
//
// Uses the authenticated OrbitClient (same code path the plugin runs), so
// every merge goes through /api/v1/merge and gets audit-logged in Supabase
// merge_audit. Universal — works for any Orbit deployment/user.
//
// Usage:
//   node scripts/run-resolver.js                 # dry-run Stage A
//   node scripts/run-resolver.js --apply         # apply Stage A (certain)
//   node scripts/run-resolver.js --apply --both  # Stage A + Stage B preview
//   API_KEY=<orb_live_...> is read from env or .env.local

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OrbitClient } from "../packages/orbit-plugin/lib/orbit-client.js";
import { IdentityResolver } from "../packages/orbit-plugin/lib/identity-resolver.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

function loadEnv() {
  const candidates = [
    resolve(REPO_ROOT, ".env.local"),
    resolve(REPO_ROOT, "..", "..", "..", ".env.local"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return Object.fromEntries(
        readFileSync(p, "utf-8")
          .split("\n")
          .filter((l) => l && !l.startsWith("#"))
          .map((l) => {
            const i = l.indexOf("=");
            return [l.slice(0, i), l.slice(i + 1).trim()];
          })
      );
    }
  }
  return {};
}

const env = { ...loadEnv(), ...process.env };
const apiKey = env.ORBIT_API_KEY || env.API_KEY;
const apiUrl = env.ORBIT_API_URL || "https://orbit-mu-roan.vercel.app/api/v1";

if (!apiKey) {
  console.error("No API key. Set ORBIT_API_KEY in .env.local or env.");
  process.exit(2);
}

const APPLY = process.argv.includes("--apply");
const BOTH = process.argv.includes("--both");
const MAX = Number(process.argv.find((a) => a.startsWith("--max="))?.split("=")[1] || 200);

const client = new OrbitClient(apiKey, apiUrl);
const resolver = new IdentityResolver({ client });

(async () => {
  console.log(`API: ${apiUrl}`);
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"}  Stage: ${BOTH ? "A+B(preview)" : "A"}`);

  let result;
  if (BOTH) {
    result = await resolver.resolve({
      dryRun: !APPLY,
      stageBPreview: true,
      maxClusters: MAX,
    });
  } else {
    result = await resolver.runStageA({ dryRun: !APPLY, maxMerges: MAX });
  }

  console.log("");
  console.log("══ Stage A ══");
  const a = result.stageA || result; // resolve() wraps; runStageA returns flat
  console.log(`  persons scanned:  ${a.personsScanned}`);
  console.log(`  clusters found:   ${a.clustersFound}`);
  console.log(`  certain:          ${a.certainCount}`);
  console.log(`  ambiguous:        ${a.ambiguousCount}`);
  if (APPLY) {
    console.log(`  merges applied:   ${a.appliedCount}`);
    console.log(`  merges skipped:   ${a.skippedCount}`);
  }
  if (a.certainPreview?.length) {
    console.log("");
    console.log("  certain (first 10):");
    for (const c of a.certainPreview) {
      console.log(`    ${c.canonical} ← ${c.merge.length} (${c.names.slice(0, 4).join(" | ")}${c.names.length > 4 ? " …" : ""})`);
    }
  }
  if (a.ambiguousPreview?.length) {
    console.log("");
    console.log("  ambiguous (first 10, deferred):");
    for (const c of a.ambiguousPreview) {
      console.log(`    ${c.canonical} ← ${c.merge.length} (${c.names.slice(0, 4).join(" | ")}${c.names.length > 4 ? " …" : ""})`);
    }
  }

  if (result.stageB) {
    console.log("");
    console.log("══ Stage B ══");
    if (result.stageB.skipped) {
      console.log(`  skipped: ${result.stageB.reason}`);
    } else {
      console.log(`  candidate clusters: ${result.stageB.candidateClusters}`);
      console.log(`  LLM proposals:      ${result.stageB.proposals}`);
      console.log(`  applied:            ${result.stageB.applied} (applyMerges=${result.stageB.applyMerges})`);
      if (result.stageB.preview?.length) {
        console.log("  preview:");
        for (const p of result.stageB.preview) {
          console.log(`    canonical=${p.canonical} merge=${p.merge_ids.length} conf=${p.confidence.toFixed(2)} — ${p.reasoning}`);
        }
      }
    }
  }

  console.log("");
  console.log(APPLY ? "Done. Run `npm run verify` to see scorecard." : "Dry-run complete. Add --apply to execute.");
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
