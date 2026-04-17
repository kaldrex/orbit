#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  canonicalWhatsappExportMessage,
  isDirectMessageChat,
  uniqueBy,
} from "../lib/export-common.js";

function parseArgs(argv) {
  const out = {
    out: "",
    reportOut: "",
    checkpointOut: "",
    chatLimit: 20000,
    pageSize: 200,
    backfillRoundCap: 40,
    backfillStableRounds: 3,
    backfillCount: 50,
    backfillRequests: 1,
    backfillWaitSeconds: 60,
    syncOnce: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") out.out = argv[++i];
    else if (arg === "--report-out") out.reportOut = argv[++i];
    else if (arg === "--checkpoint-out") out.checkpointOut = argv[++i];
    else if (arg === "--chat-limit") out.chatLimit = Number(argv[++i]);
    else if (arg === "--page-size") out.pageSize = Number(argv[++i]);
    else if (arg === "--backfill-round-cap") out.backfillRoundCap = Number(argv[++i]);
    else if (arg === "--backfill-stable-rounds") out.backfillStableRounds = Number(argv[++i]);
    else if (arg === "--backfill-count") out.backfillCount = Number(argv[++i]);
    else if (arg === "--backfill-requests") out.backfillRequests = Number(argv[++i]);
    else if (arg === "--backfill-wait-seconds") out.backfillWaitSeconds = Number(argv[++i]);
    else if (arg === "--no-sync") out.syncOnce = false;
    else if (arg === "--dry-run") out.dryRun = true;
  }
  if (!out.out || !out.reportOut) {
    throw new Error("Usage: export-whatsapp-whole.mjs --out <file> --report-out <file> [--checkpoint-out <file>] [options]");
  }
  return out;
}

function runJson(args, { allowFailure = false } = {}) {
  try {
    const raw = execFileSync(resolveWacliPath(), ["--json", ...args], {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    }).trim();
    const data = JSON.parse(raw);
    return { ok: true, raw, data };
  } catch (error) {
    if (!allowFailure) throw error;
    return { ok: false, error: error.message };
  }
}

let resolvedWacliPath = null;
function resolveWacliPath() {
  if (resolvedWacliPath) return resolvedWacliPath;
  for (const candidate of ["wacli", "/home/sanchay/bin/wacli"]) {
    try {
      execFileSync(candidate, ["--help"], {
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
      });
      resolvedWacliPath = candidate;
      return resolvedWacliPath;
    } catch {
      // try next candidate
    }
  }
  throw new Error("Could not find wacli on PATH or /home/sanchay/bin/wacli");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();

  let checkpoint = { completedChatJids: [] };
  if (opts.checkpointOut) {
    try {
      checkpoint = JSON.parse(await fs.readFile(opts.checkpointOut, "utf8"));
    } catch {
      checkpoint = { completedChatJids: [] };
    }
  }

  const chatsRes = runJson(["chats", "list", "--limit", String(opts.chatLimit)]);
  const chats = (chatsRes.data?.data || []).filter(isDirectMessageChat);

  const report = {
    generatedAt: startedAt,
    source: "whatsapp",
    totalChatsSeen: (chatsRes.data?.data || []).length,
    dmChatsIncluded: chats.length,
    totalMessagesExported: 0,
    completedChats: 0,
    saturatedChats: 0,
    cappedChats: 0,
    failedChats: 0,
    chats: [],
  };

  await fs.mkdir(path.dirname(opts.out), { recursive: true });
  const seenChatJids = new Set(checkpoint.completedChatJids || []);
  const fileHandle = await fs.open(opts.out, checkpoint.completedChatJids?.length ? "a" : "w");

  async function persistReport() {
    await fs.writeFile(opts.reportOut, JSON.stringify(report, null, 2));
    if (opts.checkpointOut) {
      await fs.writeFile(
        opts.checkpointOut,
        JSON.stringify({ completedChatJids: [...seenChatJids] }, null, 2)
      );
    }
  }
  await persistReport();

  try {
    for (const chat of chats) {
      const chatJid = chat.JID;
      if (seenChatJids.has(chatJid)) continue;
      const contactRes = runJson(["contacts", "show", "--jid", chatJid], { allowFailure: true });
      const contact = contactRes.ok ? contactRes.data?.data || null : null;

      let rounds = 0;
      let stableRounds = 0;
      let previousOldest = null;
      let previousCount = -1;
      let completionState = "complete";
      let completionReason = "initial export";
      let finalMessages = [];

      while (true) {
        const pages = [];
        let before = null;
        while (true) {
          const args = ["messages", "list", "--chat", chatJid, "--limit", String(opts.pageSize)];
          if (before) args.push("--before", before);
          const msgRes = runJson(args, { allowFailure: true });
          if (!msgRes.ok) {
            completionState = "failed";
            completionReason = `messages list failed: ${msgRes.error}`;
            break;
          }
          const batch = msgRes.data?.data?.messages || [];
          if (!batch.length) break;
          pages.push(...batch);
          if (batch.length < opts.pageSize) break;
          const oldest = batch[batch.length - 1]?.Timestamp;
          if (!oldest || oldest === before) break;
          before = oldest;
        }

        finalMessages = uniqueBy(pages, (m) => m.MsgID || `${m.ChatJID}:${m.Timestamp}:${m.Text}`);
        const ordered = finalMessages
          .map((m) => Date.parse(m.Timestamp || ""))
          .filter((x) => !Number.isNaN(x))
          .sort((a, b) => a - b);
        const oldest = ordered.length ? new Date(ordered[0]).toISOString() : null;
        const count = finalMessages.length;

        const progressed = oldest !== previousOldest || count !== previousCount;
        if (progressed) {
          stableRounds = 0;
          previousOldest = oldest;
          previousCount = count;
        } else {
          stableRounds += 1;
        }

        if (opts.dryRun) {
          completionState = "complete";
          completionReason = "dry-run export";
          break;
        }

        if (opts.backfillRoundCap <= 0) {
          completionState = "complete";
          completionReason = "exported available local history only";
          break;
        }

        if (stableRounds >= opts.backfillStableRounds) {
          completionState = "saturated";
          completionReason = "no older history or count increase";
          break;
        }

        if (rounds >= opts.backfillRoundCap) {
          completionState = "capped";
          completionReason = "backfill round cap reached";
          break;
        }

        rounds += 1;
        const backfill = runJson(
          [
            "history",
            "backfill",
            "--chat",
            chatJid,
            "--count",
            String(opts.backfillCount),
            "--requests",
            String(opts.backfillRequests),
            "--wait",
            `${opts.backfillWaitSeconds}s`,
          ],
          { allowFailure: true }
        );

        if (!backfill.ok) {
          stableRounds += 1;
        } else if (backfill.data?.success === false) {
          stableRounds += 1;
          completionReason = backfill.data?.error || completionReason;
        }
      }

      const orderedTimes = finalMessages
        .map((m) => Date.parse(m.Timestamp || ""))
        .filter((x) => !Number.isNaN(x))
        .sort((a, b) => a - b);
      const firstMessageAt = orderedTimes.length ? new Date(orderedTimes[0]).toISOString() : null;
      const lastMessageAt = orderedTimes.length ? new Date(orderedTimes[orderedTimes.length - 1]).toISOString() : null;

      report.totalMessagesExported += finalMessages.length;
      if (completionState === "complete") report.completedChats += 1;
      if (completionState === "saturated") report.saturatedChats += 1;
      if (completionState === "capped") report.cappedChats += 1;
      if (completionState === "failed") report.failedChats += 1;
      report.chats.push({
        chat_jid: chatJid,
        person_name: contact?.Name || chat.Name || "",
        message_count: finalMessages.length,
        first_message_at: firstMessageAt,
        last_message_at: lastMessageAt,
        backfill_rounds: rounds,
        completion_state: completionState,
        completion_reason: completionReason,
      });

      const lines = [];
      for (const message of finalMessages) {
        const exported = canonicalWhatsappExportMessage({
          chat,
          contact,
          message,
          backfill: {
            rounds,
            completion_state: completionState,
            completion_reason: completionReason,
            older_messages_present: Boolean(firstMessageAt && lastMessageAt && firstMessageAt !== lastMessageAt),
            first_message_at: firstMessageAt,
            last_message_at: lastMessageAt,
            message_count_for_chat: finalMessages.length,
          },
        });
        lines.push(`${JSON.stringify(exported)}\n`);
      }
      if (lines.length) {
        await fileHandle.write(lines.join(""));
      }
      seenChatJids.add(chatJid);
      await persistReport();
    }
  } finally {
    await fileHandle.close();
  }

  await persistReport();
  console.log(JSON.stringify(report, null, 2));
}

await main();
