#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    ...options,
  }).trim();
}

function parseArgs(argv) {
  const out = {
    remoteBase: "/home/sanchay/.orbit-export",
    chatLimit: 20000,
    whatsappPageSize: 200,
    whatsappBackfillRoundCap: 40,
    gmailPageCap: 0,
    gmailMaxResults: 500,
    pollSeconds: 10,
    stamp: "",
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--remote-base") out.remoteBase = argv[++i];
    else if (arg === "--chat-limit") out.chatLimit = Number(argv[++i]);
    else if (arg === "--whatsapp-page-size") out.whatsappPageSize = Number(argv[++i]);
    else if (arg === "--whatsapp-backfill-round-cap") out.whatsappBackfillRoundCap = Number(argv[++i]);
    else if (arg === "--gmail-page-cap") out.gmailPageCap = Number(argv[++i]);
    else if (arg === "--gmail-max-results") out.gmailMaxResults = Number(argv[++i]);
    else if (arg === "--poll-seconds") out.pollSeconds = Number(argv[++i]);
    else if (arg === "--stamp") out.stamp = argv[++i];
    else if (arg === "--dry-run") out.dryRun = true;
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));
const stamp = opts.stamp || new Date().toISOString().replace(/[:.]/g, "-");
const localOut = path.join(repoRoot, "outputs", "whole-data", stamp);
const remoteOut = `${opts.remoteBase}/${stamp}`;

await fs.mkdir(localOut, { recursive: true });

run("rsync", [
  "-az",
  "--exclude",
  "node_modules",
  path.join(repoRoot, "packages", "orbit-plugin", "lib") + "/",
  "claw:~/.openclaw/plugins/orbit-connector/lib/",
]);

run("rsync", [
  "-az",
  "--exclude",
  "node_modules",
  path.join(repoRoot, "packages", "orbit-plugin", "scripts") + "/",
  "claw:~/.openclaw/plugins/orbit-connector/scripts/",
]);

run("ssh", ["-o", "BatchMode=yes", "claw", "mkdir", "-p", remoteOut]);

const remoteWhatsappReport = `${remoteOut}/whatsapp-report.json`;
const remoteWhatsappCheckpoint = `${remoteOut}/whatsapp-checkpoint.json`;
const remoteGmailReport = `${remoteOut}/gmail-report.json`;
const remoteGmailCheckpoint = `${remoteOut}/gmail-checkpoint.json`;
const remoteStatus = `${remoteOut}/status.json`;

const whatsappArgs = [
  "node",
  "/home/sanchay/.openclaw/plugins/orbit-connector/scripts/export-whatsapp-whole.mjs",
  "--out",
  `${remoteOut}/whatsapp.jsonl`,
  "--report-out",
  remoteWhatsappReport,
  "--checkpoint-out",
  remoteWhatsappCheckpoint,
  "--chat-limit",
  String(opts.chatLimit),
  "--page-size",
  String(opts.whatsappPageSize),
  "--backfill-round-cap",
  String(opts.whatsappBackfillRoundCap),
];
if (opts.dryRun) whatsappArgs.push("--dry-run");

const gmailArgs = [
  "node",
  "/home/sanchay/.openclaw/plugins/orbit-connector/scripts/export-gmail-whole.mjs",
  "--out",
  `${remoteOut}/gmail.jsonl`,
  "--report-out",
  remoteGmailReport,
  "--checkpoint-out",
  remoteGmailCheckpoint,
  "--max-results",
  String(opts.gmailMaxResults),
];
if (opts.gmailPageCap > 0) {
  gmailArgs.push("--page-cap", String(opts.gmailPageCap));
}
if (opts.dryRun) gmailArgs.push("--dry-run");
const remoteScript = `
set -euo pipefail
STATUS=${JSON.stringify(remoteStatus)}
WHATSAPP_REPORT=${JSON.stringify(remoteWhatsappReport)}
GMAIL_REPORT=${JSON.stringify(remoteGmailReport)}
printf '{"state":"running","phases":["whatsapp","gmail"]}\n' > "$STATUS"
${whatsappArgs.map((x) => JSON.stringify(x)).join(" ")} &
WHATSAPP_PID=$!
${gmailArgs.map((x) => JSON.stringify(x)).join(" ")} &
GMAIL_PID=$!
set +e
wait "$WHATSAPP_PID"
WHATSAPP_EXIT=$?
wait "$GMAIL_PID"
GMAIL_EXIT=$?
set -e
if [ "$WHATSAPP_EXIT" -ne 0 ] || [ "$GMAIL_EXIT" -ne 0 ]; then
  printf '{"state":"failed","phases":["whatsapp","gmail"],"whatsappExit":%s,"gmailExit":%s}\n' "$WHATSAPP_EXIT" "$GMAIL_EXIT" > "$STATUS"
  exit 1
fi
printf '{"state":"complete","phases":["whatsapp","gmail"]}\n' > "$STATUS"
`;

const sshChild = spawn("ssh", ["-o", "BatchMode=yes", "claw", "bash", "-lc", remoteScript], {
  stdio: ["ignore", "pipe", "pipe"],
});

sshChild.stdout.on("data", (chunk) => process.stdout.write(chunk));
sshChild.stderr.on("data", (chunk) => process.stderr.write(chunk));

while (true) {
  await new Promise((r) => setTimeout(r, opts.pollSeconds * 1000));
  try {
    run("rsync", ["-az", `claw:${remoteOut}/`, `${localOut}/`]);
  } catch {
    // best effort while remote output is still forming
  }
  const exited = sshChild.exitCode !== null;
  if (exited) break;
}

const exitCode = await new Promise((resolve) => sshChild.on("close", resolve));
run("rsync", ["-az", `claw:${remoteOut}/`, `${localOut}/`]);
if (exitCode !== 0) {
  throw new Error(`Remote export failed with exit code ${exitCode}`);
}

const [whatsappReportRaw, gmailReportRaw] = await Promise.all([
  fs.readFile(path.join(localOut, "whatsapp-report.json"), "utf8"),
  fs.readFile(path.join(localOut, "gmail-report.json"), "utf8"),
]);
const whatsappReport = JSON.parse(whatsappReportRaw);
const gmailReport = JSON.parse(gmailReportRaw);

const manifest = {
  generatedAt: new Date().toISOString(),
  localOut,
  remoteOut,
  whatsapp: whatsappReport,
  gmail: gmailReport,
};

await fs.writeFile(path.join(localOut, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
