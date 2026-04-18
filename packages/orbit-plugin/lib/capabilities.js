/**
 * Capabilities — detect which channels, data sources, and tools are wired
 * on the local OpenClaw agent by introspecting ~/.openclaw/openclaw.json
 * and checking for known filesystem paths / env vars.
 *
 * The plugin POSTs this report to the server on startup and every 30 min,
 * so the web onboarding UI can show a green/red checklist.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter } from "node:path";
import { resolveGwsPath } from "./gws-path.js";

const CONFIG_PATH = join(homedir(), ".openclaw", "openclaw.json");

function readConfig() {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    // openclaw.json is JSON5 — strip // and /* */ comments, allow trailing commas
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

function cliExists(name) {
  const paths = (process.env.PATH || "").split(delimiter);
  for (const dir of paths) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return true;
    } catch {
      // ignore unreadable dirs
    }
  }
  return false;
}

/**
 * Introspect the local agent and return a capability report.
 *
 * Shape:
 * {
 *   agentId: string,
 *   hostname: string,
 *   channels: { whatsapp, telegram, slack, discord, imessage },
 *   dataSources: { whatsappHistory, gmail, calendar, slack, linear },
 *   tools: { gws, wacli }
 * }
 */
export function introspectCapabilities() {
  const config = readConfig();
  const channels = config?.channels ?? {};

  // Data source paths (checked twice — once for channel "on" signal and once
  // for data-source reporting below).
  const whatsappHistoryDir = join(homedir(), "gowa", "storages");
  const whatsappHistoryOn = existsSync(whatsappHistoryDir);
  const wacliDb = join(homedir(), ".wacli", "wacli.db");
  const wacliOn = existsSync(wacliDb);

  // Channel connectivity = explicit channel config OR historical data on disk
  const whatsappChannelConfigured =
    channels.whatsapp?.dmPolicy !== "disabled" &&
    (channels.whatsapp?.allowFrom?.length > 0 ||
      channels.whatsapp?.dmPolicy === "open");
  const whatsappOn = whatsappChannelConfigured || whatsappHistoryOn || wacliOn;
  const telegramOn =
    channels.telegram?.enabled !== false &&
    Boolean(channels.telegram?.botToken);
  const slackChannelOn =
    Boolean(channels.slack?.enabled) ||
    Boolean(process.env.SLACK_BOT_TOKEN);
  const discordOn =
    channels.discord?.enabled !== false && Boolean(channels.discord?.botToken);
  const imessageOn = Boolean(channels.imessage?.enabled);

  // Data sources on disk / CLI. For gws, use the shared resolver so the
  // capability report and the Gmail connector's availability check always
  // agree — even under the stripped PATH the gateway subprocess inherits.
  const gwsPath = resolveGwsPath();
  const gwsCli = gwsPath !== null;
  const wacliCli = cliExists("wacli");
  const linearApiKey =
    Boolean(process.env.LINEAR_API_KEY) || Boolean(process.env.LINEAR_API_TOKEN);

  return {
    agentId: config?.agents?.list?.[0]?.id || "main",
    hostname: process.env.HOSTNAME || "",
    channels: {
      whatsapp: Boolean(whatsappOn),
      telegram: Boolean(telegramOn),
      slack: Boolean(slackChannelOn),
      discord: Boolean(discordOn),
      imessage: Boolean(imessageOn),
    },
    dataSources: {
      whatsappHistory: whatsappHistoryOn,
      gmail: gwsCli,
      calendar: gwsCli,
      slack: slackChannelOn,
      linear: linearApiKey,
    },
    tools: {
      gws: gwsCli,
      gwsPath,
      wacli: wacliCli,
    },
    reportedAt: new Date().toISOString(),
  };
}
