"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Particles } from "@/components/ui/particles";
import { TextAnimate } from "@/components/ui/text-animate";
import { BorderBeam } from "@/components/ui/border-beam";
import { useEffect, useState } from "react";

const FEATURES = [
  {
    title: "Constellation Graph",
    description:
      "Your entire network as an interactive map. High-value contacts at the center, everyone else in orbit.",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
      </svg>
    ),
  },
  {
    title: "Intro Path Finder",
    description:
      "The warmest path to anyone through your existing connections. Two hops, ranked by relationship strength.",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
      </svg>
    ),
  },
  {
    title: "Going Cold Alerts",
    description:
      "Flags high-value relationships that are fading. 14 days of silence on a key contact triggers an alert.",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
      </svg>
    ),
  },
  {
    title: "Network Intelligence",
    description:
      "Blind spots, super-connectors, concentration risks. See the topology of your network, not just the names.",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5" />
      </svg>
    ),
  },
  {
    title: "Topic Resonance",
    description:
      "What you and each contact discuss most. Find the people aligned with what you care about.",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 8.25h15m-16.5 7.5h15m-1.8-13.5l-3.9 19.5m-2.1-19.5l-3.9 19.5" />
      </svg>
    ),
  },
  {
    title: "Meeting Briefs",
    description:
      "Before every meeting: who they are, shared history, topics, and what to talk about. Automatic.",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
      </svg>
    ),
  },
];

const CONSTELLATION_NODES = [
  { x: "50%", y: "50%", size: 6, color: "#fff", glow: "rgba(255,255,255,0.3)", label: "You" },
  { x: "22%", y: "28%", size: 5, color: "#3B82F6", glow: "rgba(59,130,246,0.25)" },
  { x: "73%", y: "22%", size: 4, color: "#22C55E", glow: "rgba(34,197,94,0.25)" },
  { x: "82%", y: "52%", size: 5, color: "#F97316", glow: "rgba(249,115,22,0.25)" },
  { x: "32%", y: "74%", size: 4, color: "#EAB308", glow: "rgba(234,179,8,0.25)" },
  { x: "14%", y: "52%", size: 3, color: "#06B6D4", glow: "rgba(6,182,212,0.2)" },
  { x: "58%", y: "16%", size: 3, color: "#EC4899", glow: "rgba(236,72,153,0.2)" },
  { x: "65%", y: "72%", size: 4, color: "#8B5CF6", glow: "rgba(139,92,246,0.25)" },
  { x: "40%", y: "88%", size: 2.5, color: "#14B8A6", glow: "rgba(20,184,166,0.15)" },
  { x: "88%", y: "34%", size: 2.5, color: "#EF4444", glow: "rgba(239,68,68,0.15)" },
  { x: "10%", y: "78%", size: 2, color: "#64748B", glow: "rgba(100,116,139,0.1)" },
  { x: "78%", y: "82%", size: 2, color: "#64748B", glow: "rgba(100,116,139,0.1)" },
];

const EDGES = [
  ["50%","50%","22%","28%"], ["50%","50%","73%","22%"], ["50%","50%","82%","52%"],
  ["50%","50%","32%","74%"], ["50%","50%","14%","52%"], ["50%","50%","58%","16%"],
  ["50%","50%","65%","72%"], ["22%","28%","58%","16%"], ["73%","22%","82%","52%"],
  ["32%","74%","65%","72%"], ["14%","52%","22%","28%"], ["82%","52%","78%","82%"],
];

export default function LandingPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-100 overflow-hidden">
      {/* Particles — white, subtle */}
      {mounted && (
        <Particles
          className="fixed inset-0 z-0"
          quantity={60}
          color="#ffffff"
          size={0.3}
          staticity={50}
          ease={70}
        />
      )}

      {/* Subtle radial glow — warm, not purple */}
      <div className="fixed inset-0 z-0 pointer-events-none">
        <div className="absolute top-[-30%] left-[50%] -translate-x-1/2 w-[800px] h-[800px] rounded-full bg-white/[0.015] blur-[120px]" />
      </div>

      {/* Nav */}
      <nav className="relative z-10 flex items-center justify-between px-8 py-5 max-w-7xl mx-auto">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-full bg-white flex items-center justify-center text-[11px] font-bold text-black">
            O
          </div>
          <span className="text-[16px] font-semibold tracking-[-0.03em]">Orbit</span>
        </div>
        <div className="flex items-center gap-1">
          <Link href="/login">
            <Button
              variant="ghost"
              className="text-zinc-400 hover:text-white text-[13px] font-medium h-9 px-4"
            >
              Sign in
            </Button>
          </Link>
          <Link href="/signup">
            <Button className="bg-white text-black hover:bg-zinc-200 text-[13px] font-medium h-9 px-5 rounded-lg">
              Get started
            </Button>
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative z-10 flex flex-col items-center text-center px-6 pt-24 pb-28 max-w-4xl mx-auto">
        <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/50 px-3.5 py-1 text-[12px] text-zinc-400 backdrop-blur-sm tracking-wide uppercase font-medium">
          <span className="w-1 h-1 rounded-full bg-emerald-400" />
          Relationship Intelligence
        </div>

        <h1 className="text-[clamp(2.8rem,6.5vw,5.2rem)] font-bold tracking-[-0.05em] leading-[0.95] mb-6">
          <TextAnimate animation="blurInUp" by="word" delay={0.04}>
            Your network is your
          </TextAnimate>
          <br />
          <span className="font-[family-name:var(--font-serif)] italic font-normal text-zinc-300">
            net worth
          </span>
        </h1>

        <p className="text-[17px] text-zinc-500 max-w-lg mb-10 leading-relaxed font-light">
          Orbit maps every relationship into a living constellation — surfacing warm intros,
          fading connections, and hidden intelligence.
        </p>

        <div className="flex items-center gap-4">
          <Link href="/signup">
            <Button className="bg-white text-black hover:bg-zinc-200 text-[14px] font-medium h-11 px-8 rounded-lg">
              Start for free
            </Button>
          </Link>
          <span className="text-[12px] text-zinc-600">No credit card required</span>
        </div>
      </section>

      {/* Constellation preview */}
      <section className="relative z-10 max-w-4xl mx-auto px-6 pb-32">
        <div className="relative rounded-2xl border border-zinc-800/60 bg-zinc-950/50 p-1 overflow-hidden">
          <BorderBeam size={250} duration={15} colorFrom="#ffffff" colorTo="#3b82f6" />
          <div className="rounded-xl bg-[#0a0a0f] p-6 min-h-[380px] flex items-center justify-center relative">
            <div className="relative w-full max-w-md aspect-square">
              {/* Edges */}
              <svg className="absolute inset-0 w-full h-full" xmlns="http://www.w3.org/2000/svg">
                {EDGES.map(([x1, y1, x2, y2], i) => (
                  <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
                ))}
              </svg>
              {/* Nodes */}
              {CONSTELLATION_NODES.map((node, i) => (
                <div
                  key={i}
                  className="absolute -translate-x-1/2 -translate-y-1/2"
                  style={{ left: node.x, top: node.y }}
                >
                  <div
                    className="rounded-full animate-pulse"
                    style={{
                      width: `${node.size * 2.5}px`,
                      height: `${node.size * 2.5}px`,
                      backgroundColor: node.color,
                      boxShadow: `0 0 ${node.size * 4}px ${node.glow}`,
                      animationDuration: `${3 + i * 0.4}s`,
                    }}
                  />
                  {node.label && (
                    <span className="absolute top-full left-1/2 -translate-x-1/2 mt-2 text-[10px] text-zinc-500 whitespace-nowrap">
                      {node.label}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="relative z-10 max-w-5xl mx-auto px-6 pb-32">
        <div className="text-center mb-14">
          <h2 className="text-[28px] font-bold tracking-[-0.04em] mb-3">
            Intelligence, not just{" "}
            <span className="font-[family-name:var(--font-serif)] italic font-normal text-zinc-400">
              contacts
            </span>
          </h2>
          <p className="text-zinc-500 text-[15px] max-w-md mx-auto">
            Orbit understands the topology of your relationships.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-px bg-zinc-800/30 rounded-2xl overflow-hidden border border-zinc-800/40">
          {FEATURES.map((feature, i) => (
            <div
              key={i}
              className="bg-[#09090b] p-7 hover:bg-zinc-900/50 transition-colors duration-200"
            >
              <div className="w-9 h-9 rounded-lg bg-zinc-800/50 flex items-center justify-center text-zinc-400 mb-4">
                {feature.icon}
              </div>
              <h3 className="text-[14px] font-semibold mb-1.5 tracking-[-0.01em] text-zinc-200">
                {feature.title}
              </h3>
              <p className="text-[13px] text-zinc-500 leading-relaxed">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Bottom CTA */}
      <section className="relative z-10 max-w-2xl mx-auto px-6 pb-20 text-center">
        <div className="border border-zinc-800/50 rounded-2xl bg-zinc-900/30 p-12">
          <h2 className="text-[22px] font-bold tracking-[-0.03em] mb-3">
            See your network clearly
          </h2>
          <p className="text-zinc-500 text-[14px] mb-7">
            Built for founders who take relationships seriously.
          </p>
          <Link href="/signup">
            <Button className="bg-white text-black hover:bg-zinc-200 text-[14px] font-medium h-11 px-8 rounded-lg">
              Get started for free
            </Button>
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="relative z-10 border-t border-zinc-800/30 py-8 text-center">
        <div className="flex items-center justify-center gap-2 text-[13px] text-zinc-600">
          <div className="w-3.5 h-3.5 rounded-full bg-white/80" />
          Orbit
        </div>
      </footer>
    </div>
  );
}
