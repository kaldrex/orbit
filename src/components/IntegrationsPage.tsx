"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

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

interface IntegrationsPageProps {
  apiKeyPrefix: string | null;
}

/**
 * Integrations page — post-cutover surface. OpenClaw owns channels;
 * this page no longer tries to authenticate Google / upload WhatsApp
 * exports directly. Instead it surfaces:
 *   1. The current api_key prefix + a "Generate new key" button that
 *      reuses /api/v1/keys. The raw key is shown exactly once.
 *   2. Live agent capabilities polled from /api/v1/capabilities — the
 *      same shape the onboarding page uses to track which channels
 *      and data sources the founder's claw is reporting.
 *   3. A short blurb pointing at onboarding for install instructions.
 */
export function IntegrationsPage({ apiKeyPrefix }: IntegrationsPageProps) {
  const [prefix, setPrefix] = useState(apiKeyPrefix);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [keyLoading, setKeyLoading] = useState(false);
  const [agents, setAgents] = useState<AgentReport[]>([]);

  async function fetchCapabilities() {
    const res = await fetch("/api/v1/capabilities");
    if (!res.ok) return;
    const data = await res.json();
    setAgents(data.agents ?? []);
  }

  async function generateKey() {
    setKeyLoading(true);
    setNewKey(null);
    try {
      const res = await fetch("/api/v1/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Integrations page" }),
      });
      const data = await res.json();
      if (data.key) {
        setNewKey(data.key);
        setPrefix(data.prefix ?? null);
      }
    } finally {
      setKeyLoading(false);
    }
  }

  useEffect(() => {
    fetchCapabilities();
    const id = setInterval(fetchCapabilities, 15000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-100">
      <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-800/40">
        <div className="flex items-center gap-4">
          <Link href="/dashboard">
            <Button variant="ghost" className="text-zinc-400 hover:text-zinc-200 h-8 px-2 text-[13px]">
              &larr; Dashboard
            </Button>
          </Link>
          <h1 className="text-[16px] font-semibold tracking-[-0.02em]">Integrations</h1>
        </div>
      </header>

      <div className="max-w-3xl mx-auto px-6 py-10 space-y-10">
        {/* API Key */}
        <section>
          <h2 className="text-[14px] font-medium text-zinc-200 mb-3">API key</h2>
          <div className="rounded-xl border border-zinc-800/50 bg-zinc-900/30 p-5 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[12px] text-zinc-500">Current key</p>
                <p className="mt-1 font-mono text-[13px] text-zinc-200">
                  {prefix ? `cal_live_…${prefix.slice(-4)}` : "No key on file"}
                </p>
              </div>
              <Button
                onClick={generateKey}
                disabled={keyLoading}
                className="h-8 text-[12px] bg-white text-black hover:bg-zinc-200"
              >
                {keyLoading ? "Generating…" : "Generate new key"}
              </Button>
            </div>

            {newKey && (
              <div>
                <p className="text-[11px] text-zinc-500 mb-2">
                  Your new key — shown once. Save it somewhere safe.
                </p>
                <pre className="bg-zinc-950 border border-zinc-800 rounded-md px-3 py-2 text-[12px] text-zinc-300 font-mono whitespace-pre-wrap break-all">
                  {newKey}
                </pre>
              </div>
            )}
          </div>
        </section>

        {/* Agent capabilities */}
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-[14px] font-medium text-zinc-200">Agent capabilities</h2>
            {agents.length === 0 && (
              <span className="text-[11px] text-zinc-600">Waiting for agent…</span>
            )}
          </div>

          {agents.length === 0 ? (
            <div className="rounded-xl border border-zinc-800/50 bg-zinc-900/30 p-5 text-[13px] text-zinc-400">
              No agent has reported in yet. Once your OpenClaw plugin is
              installed and running, its channels and data sources will
              appear here within a minute.
            </div>
          ) : (
            <div className="space-y-3">
              {agents.map((agent) => (
                <AgentCard key={agent.agentId + agent.hostname} agent={agent} />
              ))}
            </div>
          )}
        </section>

        {/* Blurb */}
        <section>
          <div className="rounded-xl border border-zinc-800/50 bg-zinc-900/30 p-5 text-[13px] text-zinc-400 leading-relaxed">
            Channels are managed via OpenClaw on your claw VM. Orbit
            never talks to WhatsApp, Gmail, or Calendar directly — your
            agent does. See the{" "}
            <Link href="/onboarding" className="text-zinc-200 hover:underline">
              onboarding page
            </Link>{" "}
            for install instructions.
          </div>
        </section>
      </div>
    </div>
  );
}

function AgentCard({ agent }: { agent: AgentReport }) {
  const checks = [
    ...Object.entries(agent.channels).map(([k, v]) => ({
      key: k,
      label: CHANNEL_LABELS[k] ?? k,
      ok: v,
      kind: "channel" as const,
    })),
    ...Object.entries(agent.dataSources).map(([k, v]) => ({
      key: k,
      label: SOURCE_LABELS[k] ?? k,
      ok: v,
      kind: "source" as const,
    })),
  ];
  const greens = checks.filter((c) => c.ok).length;

  return (
    <div className="rounded-xl border border-zinc-800/50 bg-zinc-900/30 p-5">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <div className="text-[14px] font-medium text-zinc-200">{agent.agentId}</div>
          {agent.hostname && (
            <div className="text-[11px] text-zinc-500 font-mono">{agent.hostname}</div>
          )}
        </div>
        <div className="text-[11px] text-zinc-500">
          {greens}/{checks.length} ready
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        {checks.map((c) => (
          <div key={c.kind + c.key} className="flex items-center gap-2 text-[12px]">
            <span
              className={`w-2 h-2 rounded-full ${c.ok ? "bg-emerald-500" : "bg-zinc-700"}`}
            />
            <span className={c.ok ? "text-zinc-200" : "text-zinc-500"}>{c.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
