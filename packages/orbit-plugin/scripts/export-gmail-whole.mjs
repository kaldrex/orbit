#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { canonicalGmailExportMessage } from "../lib/export-common.js";

function parseArgs(argv) {
  const out = {
    out: "",
    reportOut: "",
    checkpointOut: "",
    pageCap: 0,
    maxResults: 500,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") out.out = argv[++i];
    else if (arg === "--report-out") out.reportOut = argv[++i];
    else if (arg === "--checkpoint-out") out.checkpointOut = argv[++i];
    else if (arg === "--page-cap") out.pageCap = Number(argv[++i]);
    else if (arg === "--max-results") out.maxResults = Number(argv[++i]);
    else if (arg === "--dry-run") out.dryRun = true;
  }
  if (!out.out || !out.reportOut) {
    throw new Error("Usage: export-gmail-whole.mjs --out <file> --report-out <file> [--checkpoint-out <file>] [options]");
  }
  return out;
}

function runJson(args) {
  const raw = execFileSync("gws", args, {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  }).trim();
  return JSON.parse(raw);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let checkpoint = { pageToken: null, seenIds: [], report: null };
  if (opts.checkpointOut) {
    try {
      checkpoint = JSON.parse(await fs.readFile(opts.checkpointOut, "utf8"));
    } catch {
      checkpoint = { pageToken: null, seenIds: [], report: null };
    }
  }
  const report = {
    generatedAt: new Date().toISOString(),
    source: "gmail",
    pagesFetched: 0,
    messagesListed: 0,
    messagesExported: 0,
    failures: [],
  };

  if (checkpoint.report) {
    Object.assign(report, checkpoint.report);
  }

  await fs.mkdir(path.dirname(opts.out), { recursive: true });
  const seenIds = new Set(checkpoint.seenIds || []);
  const handle = await fs.open(opts.out, seenIds.size ? "a" : "w");

  async function persistReport(nextPageToken) {
    await fs.writeFile(opts.reportOut, JSON.stringify(report, null, 2));
    if (opts.checkpointOut) {
      await fs.writeFile(
        opts.checkpointOut,
        JSON.stringify(
          {
            pageToken: nextPageToken ?? null,
            seenIds: [...seenIds],
            report,
          },
          null,
          2
        )
      );
    }
  }
  try {
    let pageToken = checkpoint.pageToken || null;
    await persistReport(pageToken);
    while (true) {
      if (opts.pageCap > 0 && report.pagesFetched >= opts.pageCap) break;
      const params = {
        userId: "me",
        maxResults: opts.maxResults,
      };
      if (pageToken) params.pageToken = pageToken;

      const list = runJson([
        "gmail",
        "users",
        "messages",
        "list",
        "--params",
        JSON.stringify(params),
      ]);

      report.pagesFetched += 1;
      const messages = list.messages || [];
      report.messagesListed += messages.length;

      for (const message of messages) {
        if (seenIds.has(message.id)) continue;
        try {
          const full = runJson([
            "gmail",
            "users",
            "messages",
            "get",
            "--params",
            JSON.stringify({
              userId: "me",
              id: message.id,
              format: "full",
            }),
          ]);

          const row = canonicalGmailExportMessage(full);
          report.messagesExported += 1;
          await handle.write(`${JSON.stringify(row)}\n`);
          seenIds.add(message.id);
        } catch (error) {
          report.failures.push({
            id: message.id,
            error: error.message,
          });
          const failed = {
            source: "gmail",
            source_key: message.id,
            person_candidates: [],
            thread_id: message.threadId || "",
            from_email: "",
            from_name: "",
            to_emails: [],
            subject: "",
            date: null,
            snippet: "",
            body_text: "",
            completion_state: "failed",
            detail: "",
          };
          await handle.write(`${JSON.stringify(failed)}\n`);
          seenIds.add(message.id);
        }
      }

      if (opts.dryRun) break;
      pageToken = list.nextPageToken || null;
      await persistReport(pageToken);
      if (!pageToken) break;
    }
  } finally {
    await handle.close();
  }

  await persistReport(null);
  console.log(JSON.stringify(report, null, 2));
}

await main();
