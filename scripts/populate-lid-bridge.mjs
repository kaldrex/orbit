#!/usr/bin/env node
// scripts/populate-lid-bridge.mjs
//
// One-shot: SSH to claw, dump whatsmeow_lid_map (lid, pn) from
// ~/.wacli/session.db, chunk into batches of 500, and POST each chunk to
// Orbit's /api/v1/lid_bridge/upsert endpoint with Bearer auth.
//
// The bridge is a projection that lets graph-populate resolve @lid-only
// group senders back to persons via the phones already on person cards.
// It's NOT an observation — observations remain the source of truth for
// identity; the bridge is a lookup table.
//
// Env required (reads from .env.local at the worktree root):
//   ORBIT_API_URL  — e.g. https://orbit-mu-roan.vercel.app/api/v1OR
//                    http://localhost:3047/api/v1
//   ORBIT_API_KEY  — Bearer token (orb_live_*)
//
// Usage:
//   node scripts/populate-lid-bridge.mjs
//   node scripts/populate-lid-bridge.mjs --ssh-host=claw --chunk=500
//   node scripts/populate-lid-bridge.mjs --api-url=... --api-key=...
//
// Exits non-zero on any failed batch; the run is idempotent so re-running
// is safe. Log-first, retry-never: failed batches surface their HTTP
// status and error body and we bail rather than retry blind.

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---- arg parse -----------------------------------------------------

const args = {
  sshHost: "claw",
  chunk: 500,
  apiUrl: process.env.ORBIT_API_URL,
  apiKey: process.env.ORBIT_API_KEY,
};
for (const a of process.argv.slice(2)) {
  if (a.startsWith("--ssh-host=")) args.sshHost = a.slice(11);
  else if (a.startsWith("--chunk=")) args.chunk = parseInt(a.slice(8), 10);
  else if (a.startsWith("--api-url=")) args.apiUrl = a.slice(10);
  else if (a.startsWith("--api-key=")) args.apiKey = a.slice(10);
  else if (a === "--help" || a === "-h") {
    console.log(
      "usage: node scripts/populate-lid-bridge.mjs [--ssh-host=claw] [--chunk=500] [--api-url=...] [--api-key=...]",
    );
    process.exit(0);
  }
}

// Load .env.local from the worktree root (two levels up from this file).
function loadDotEnvLocal() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", ".env.local"),
    join(here, "..", "..", "..", "..", ".env.local"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (!(k in process.env)) process.env[k] = v;
    }
    return p;
  }
  return null;
}
loadDotEnvLocal();
args.apiUrl = args.apiUrl || process.env.ORBIT_API_URL;
args.apiKey = args.apiKey || process.env.ORBIT_API_KEY;

if (!args.apiUrl || !args.apiKey) {
  console.error(
    "[populate-lid-bridge] ORBIT_API_URL and ORBIT_API_KEY must be set (via env or --api-url / --api-key).",
  );
  process.exit(2);
}

// ---- helpers --------------------------------------------------------

function runChild(cmd, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ---- step 1: verify schema on claw ---------------------------------

async function verifySchema() {
  const r = await runChild("ssh", [
    args.sshHost,
    `sqlite3 ~/.wacli/session.db ".schema whatsmeow_lid_map"`,
  ]);
  if (r.code !== 0) {
    console.error("[populate-lid-bridge] ssh/.schema failed:", r.stderr || r.stdout);
    process.exit(3);
  }
  const schema = r.stdout.trim();
  console.log(`[populate-lid-bridge] whatsmeow_lid_map schema:\n${schema}`);
  // Verify both columns exist. whatsmeow currently ships (lid, pn).
  if (!/\blid\b/i.test(schema) || !/\bpn\b/i.test(schema)) {
    console.error(
      `[populate-lid-bridge] unexpected schema — expected columns 'lid' and 'pn'. Got:\n${schema}`,
    );
    process.exit(3);
  }
  return { hasLid: true, hasPn: true };
}

// ---- step 2: dump rows via ssh + sqlite3 ---------------------------

async function dumpRows() {
  // Use pipe-separator + .mode separator to avoid CSV quoting gotchas.
  // Rows are (lid, pn) — lid is PK, pn is the phone (digits only, no '+').
  const r = await runChild("ssh", [
    args.sshHost,
    `sqlite3 -separator '|' ~/.wacli/session.db "SELECT lid, pn FROM whatsmeow_lid_map"`,
  ]);
  if (r.code !== 0) {
    console.error("[populate-lid-bridge] ssh dump failed:", r.stderr || r.stdout);
    process.exit(4);
  }
  const entries = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    const pipe = s.indexOf("|");
    if (pipe < 0) continue;
    const lid = s.slice(0, pipe).trim();
    const pn = s.slice(pipe + 1).trim();
    if (!lid || !pn) continue;
    entries.push({ lid, phone: pn });
  }
  return entries;
}

// ---- step 3: POST to Orbit in chunks -------------------------------

async function postChunks(entries) {
  const target = args.apiUrl.replace(/\/$/, "") + "/lid_bridge/upsert";
  const batches = chunk(entries, args.chunk);
  let total = 0;
  let failed = 0;
  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    const t0 = Date.now();
    let res;
    try {
      res = await fetch(target, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${args.apiKey}`,
        },
        body: JSON.stringify({ entries: batch }),
      });
    } catch (e) {
      failed += 1;
      console.error(
        `[populate-lid-bridge] batch ${i + 1}/${batches.length} network error:`,
        e?.message ?? e,
      );
      // Log-first, retry-never — bail so we inspect logs before mass retry.
      process.exit(5);
    }
    const ms = Date.now() - t0;
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 400) };
    }
    if (!res.ok) {
      failed += 1;
      console.error(
        `[populate-lid-bridge] batch ${i + 1}/${batches.length} HTTP ${res.status}: ${JSON.stringify(body).slice(0, 400)}`,
      );
      process.exit(6);
    }
    const upserted = typeof body?.upserted === "number" ? body.upserted : 0;
    total += upserted;
    console.log(
      `[populate-lid-bridge] batch ${i + 1}/${batches.length}  entries=${batch.length}  upserted=${upserted}  ${ms}ms`,
    );
  }
  return { total, failed };
}

// ---- main ----------------------------------------------------------

(async () => {
  const t0 = Date.now();
  console.log(`[populate-lid-bridge] target ${args.apiUrl}  ssh=${args.sshHost}  chunk=${args.chunk}`);
  await verifySchema();
  const entries = await dumpRows();
  console.log(`[populate-lid-bridge] dumped ${entries.length} rows from claw`);
  if (entries.length === 0) {
    console.log("[populate-lid-bridge] nothing to do");
    process.exit(0);
  }
  const { total } = await postChunks(entries);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[populate-lid-bridge] done. total_upserted=${total}  entries_dumped=${entries.length}  elapsed=${secs}s`,
  );
})().catch((e) => {
  console.error("[populate-lid-bridge] fatal:", e);
  process.exit(1);
});
