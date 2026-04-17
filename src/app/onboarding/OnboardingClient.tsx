"use client";

import { useEffect, useState } from "react";

type AgentReport = {
  agentId: string;
  hostname: string;
  channels: Record<string, boolean>;
  dataSources: Record<string, boolean>;
  tools: Record<string, boolean>;
  reportedAt: string;
};

const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  slack: "Slack",
  discord: "Discord",
  imessage: "iMessage",
};

const SOURCE_LABELS: Record<string, string> = {
  whatsappHistory: "WhatsApp history",
  gmail: "Gmail",
  calendar: "Calendar",
  slack: "Slack",
  linear: "Linear",
};

const SETUP_GUIDES: Record<string, string> = {
  whatsapp: "Pair your number: run `openclaw channels login whatsapp` on your agent machine.",
  telegram: "Create a Telegram bot via @BotFather, add the token to openclaw.json under channels.telegram.botToken.",
  slack: "Set SLACK_BOT_TOKEN env var. Create the bot at api.slack.com and install to workspace.",
  discord: "Create a Discord bot, add the token to openclaw.json under channels.discord.botToken.",
  imessage: "Enable in openclaw.json under channels.imessage (macOS agent only).",
  whatsappHistory: "Install `gowa` and sync your WhatsApp history to ~/gowa/storages.",
  gmail: "Install `gws` CLI and authenticate with your Google account.",
  calendar: "Uses the same `gws` CLI as Gmail — one auth covers both.",
  linear: "Set LINEAR_API_KEY env var with a personal API token from Linear settings.",
};

export function OnboardingClient({ userEmail }: { userEmail: string }) {
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [keyLoading, setKeyLoading] = useState(false);
  const [agents, setAgents] = useState<AgentReport[]>([]);
  const [copied, setCopied] = useState(false);

  const installCommand = apiKey
    ? `openclaw plugins install orbit --marketplace Sanchay-T/orbit && openclaw env set ORBIT_API_KEY=${apiKey}`
    : "";

  async function fetchCapabilities() {
    const res = await fetch("/api/capabilities");
    if (!res.ok) return;
    const data = await res.json();
    setAgents(data.agents ?? []);
  }

  async function generateKey() {
    setKeyLoading(true);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Orbit onboarding" }),
      });
      const data = await res.json();
      if (data.key) setApiKey(data.key);
    } finally {
      setKeyLoading(false);
    }
  }

  async function copyCommand() {
    if (!installCommand) return;
    await navigator.clipboard.writeText(installCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  useEffect(() => {
    fetchCapabilities();
    const id = setInterval(fetchCapabilities, 15000);
    return () => clearInterval(id);
  }, []);

  const hasAgent = agents.length > 0;

  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-100">
      <div className="max-w-2xl mx-auto px-6 py-12">
        {/* Header */}
        <div className="mb-10">
          <div className="flex items-center gap-2 mb-1 text-zinc-500 text-sm">
            <div className="w-6 h-6 rounded-full bg-white text-black flex items-center justify-center text-xs font-medium">o</div>
            <span>Orbit</span>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight mb-2">Connect your agent</h1>
          <p className="text-zinc-400 text-sm">
            Install the Orbit plugin on your OpenClaw agent. Your agent will start building your relationship graph in the background.
          </p>
        </div>

        {/* Step 1: Generate key + copy command */}
        <section className="mb-10">
          <div className="flex items-baseline gap-2 mb-4">
            <span className="text-xs font-mono text-zinc-500">01</span>
            <h2 className="text-lg font-medium">Install command</h2>
          </div>

          {!apiKey ? (
            <button
              onClick={generateKey}
              disabled={keyLoading}
              className="w-full py-3 px-4 bg-white text-black text-sm font-medium rounded-md hover:bg-zinc-200 disabled:opacity-50 transition"
            >
              {keyLoading ? "Generating key…" : "Generate my install command"}
            </button>
          ) : (
            <div>
              <div className="relative">
                <pre className="bg-zinc-950 border border-zinc-800 rounded-md px-4 py-3 text-xs text-zinc-300 font-mono whitespace-pre-wrap break-all pr-20">
                  {installCommand}
                </pre>
                <button
                  onClick={copyCommand}
                  className="absolute top-2 right-2 text-xs px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-zinc-300 transition"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="mt-3 text-xs text-zinc-500">
                Paste this on the machine where your OpenClaw agent runs. The API key is shown once — save it somewhere safe.
              </p>
            </div>
          )}
        </section>

        {/* Step 2: Wait for handshake */}
        <section className="mb-10">
          <div className="flex items-baseline gap-2 mb-4">
            <span className="text-xs font-mono text-zinc-500">02</span>
            <h2 className="text-lg font-medium">Agent status</h2>
            {!hasAgent && (
              <span className="ml-auto text-xs text-zinc-600">Waiting for connection…</span>
            )}
          </div>

          {!hasAgent ? (
            <div className="border border-zinc-800 rounded-md p-6 text-center">
              <div className="w-6 h-6 mx-auto mb-3 rounded-full border-2 border-zinc-700 border-t-white animate-spin" />
              <p className="text-sm text-zinc-400">
                No agent has reported in yet. After you run the install command, your agent will check in within a minute.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {agents.map((agent) => (
                <AgentCard key={agent.agentId + agent.hostname} agent={agent} />
              ))}
            </div>
          )}
        </section>

        {/* Step 3: Done */}
        {hasAgent && (
          <section className="mb-10">
            <div className="flex items-baseline gap-2 mb-4">
              <span className="text-xs font-mono text-zinc-500">03</span>
              <h2 className="text-lg font-medium">You're live</h2>
            </div>
            <div className="border border-zinc-800 rounded-md p-4 text-sm text-zinc-400 space-y-2">
              <p>Your agent is ingesting in the background. This takes about 10 minutes on first run.</p>
              <p>
                <a href="/dashboard" className="text-white hover:underline">Open your constellation →</a>
              </p>
            </div>
          </section>
        )}

        <div className="mt-16 text-xs text-zinc-600">
          Signed in as {userEmail}
        </div>
      </div>
    </div>
  );
}

function AgentCard({ agent }: { agent: AgentReport }) {
  const allChecks = [
    ...Object.entries(agent.channels).map(([k, v]) => ({ key: k, label: CHANNEL_LABELS[k] ?? k, ok: v, kind: "channel" as const })),
    ...Object.entries(agent.dataSources).map(([k, v]) => ({ key: k, label: SOURCE_LABELS[k] ?? k, ok: v, kind: "source" as const })),
  ];
  const greens = allChecks.filter((c) => c.ok).length;

  return (
    <div className="border border-zinc-800 rounded-md p-4">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <div className="text-sm font-medium">{agent.agentId}</div>
          {agent.hostname && (
            <div className="text-xs text-zinc-500 font-mono">{agent.hostname}</div>
          )}
        </div>
        <div className="text-xs text-zinc-500">
          {greens}/{allChecks.length} ready
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        {allChecks.map((check) => (
          <div key={check.kind + check.key} className="flex items-center gap-2 text-sm">
            <span
              className={`w-2 h-2 rounded-full ${check.ok ? "bg-emerald-500" : "bg-zinc-700"}`}
            />
            <span className={check.ok ? "text-zinc-200" : "text-zinc-500"}>{check.label}</span>
          </div>
        ))}
      </div>

      {/* Setup guides for missing channels */}
      {allChecks.some((c) => !c.ok) && (
        <details className="mt-4 text-xs">
          <summary className="cursor-pointer text-zinc-500 hover:text-zinc-300">
            How to connect the missing ones
          </summary>
          <div className="mt-2 pl-4 space-y-2 text-zinc-400">
            {allChecks.filter((c) => !c.ok).map((check) => (
              <div key={check.kind + check.key}>
                <span className="font-medium text-zinc-300">{check.label}: </span>
                {SETUP_GUIDES[check.key] ?? "Refer to OpenClaw docs for this connector."}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
