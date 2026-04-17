#!/usr/bin/env node

import { execFileSync } from "node:child_process";

function run(cmd, args) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  }).trim();
}

function tryJson(cmd, args) {
  try {
    const raw = run(cmd, args);
    return { ok: true, data: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function gmailCheck() {
  const list = tryJson("gws", [
    "gmail",
    "users",
    "messages",
    "list",
    "--params",
    JSON.stringify({ userId: "me", maxResults: 1 }),
  ]);
  if (!list.ok) return { ok: false, error: list.error };

  const messageId = list.data?.messages?.[0]?.id;
  if (!messageId) return { ok: false, error: "No recent Gmail message found" };

  const full = tryJson("gws", [
    "gmail",
    "users",
    "messages",
    "get",
    "--params",
    JSON.stringify({ userId: "me", id: messageId, format: "full" }),
  ]);
  if (!full.ok) return { ok: false, error: full.error };

  const payload = full.data?.payload || {};
  return {
    ok: true,
    sample: {
      id: full.data?.id || messageId,
      snippet: full.data?.snippet || "",
      mimeType: payload.mimeType || "",
      partCount: Array.isArray(payload.parts) ? payload.parts.length : 0,
    },
  };
}

function calendarCheck() {
  const events = tryJson("gws", [
    "calendar",
    "events",
    "list",
    "--params",
    JSON.stringify({
      calendarId: "primary",
      maxResults: 3,
      singleEvents: true,
      timeMin: new Date().toISOString(),
      orderBy: "startTime",
    }),
  ]);
  if (!events.ok) return { ok: false, error: events.error };

  return {
    ok: true,
    sample: (events.data?.items || []).slice(0, 3).map((ev) => ({
      summary: ev.summary || "",
      start: ev.start?.dateTime || ev.start?.date || "",
      attendees: Array.isArray(ev.attendees) ? ev.attendees.length : 0,
    })),
  };
}

function whatsappCheck() {
  let cliPath = "";
  try {
    cliPath = run("bash", ["-lc", "command -v wacli || command -v /home/sanchay/bin/wacli || true"]);
  } catch {
    cliPath = "";
  }
  if (!cliPath) {
    return { ok: false, error: "wacli not found on PATH" };
  }

  const chats = tryJson(cliPath, ["chats", "list", "--json", "--limit", "3"]);
  const messages = tryJson(cliPath, ["messages", "list", "--json", "--limit", "3"]);

  return {
    ok: chats.ok || messages.ok,
    cliPath,
    chats: chats.ok ? chats.data : { error: chats.error },
    messages: messages.ok ? messages.data : { error: messages.error },
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  gmail: gmailCheck(),
  calendar: calendarCheck(),
  whatsapp: whatsappCheck(),
};

console.log(JSON.stringify(report, null, 2));
