"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { BorderBeam } from "@/components/ui/border-beam";
import { WordRotate } from "@/components/ui/word-rotate";
import { NumberTicker } from "@/components/ui/number-ticker";
import { AnimatedGradientText } from "@/components/ui/animated-gradient-text";
import { TextAnimate } from "@/components/ui/text-animate";
import { AnimatedGridPattern } from "@/components/ui/animated-grid-pattern";
import { ShimmerButton } from "@/components/ui/shimmer-button";
import { Particles } from "@/components/ui/particles";
import { GlassCard, GlassSurface } from "@/components/landing/GlassCard";
import GrainOverlay from "@/components/landing/GrainOverlay";
import {
  Sparkles, Route, Bell, Brain, Hash, FileText, ArrowRight,
} from "lucide-react";
import { OrbitLogo } from "@/components/OrbitLogo";

const ConstellationScene = dynamic(
  () => import("@/components/landing/ConstellationScene"),
  { ssr: false }
);

const FEATURES = [
  { title: "Constellation Graph", desc: "Your entire network as a living, interactive map — high-value contacts at center, everyone else in orbit.", icon: Sparkles, accent: "#3b82f6" },
  { title: "Intro Path Finder", desc: "The warmest path to anyone. Two hops through existing connections, ranked by relationship strength.", icon: Route, accent: "#22c55e" },
  { title: "Going Cold Alerts", desc: "Flags high-value relationships that are fading. 14 days of silence on a key contact triggers an alert.", icon: Bell, accent: "#f97316" },
  { title: "Network Intelligence", desc: "Blind spots, super-connectors, concentration risks. See the topology of your network, not just names.", icon: Brain, accent: "#8b5cf6" },
  { title: "Topic Resonance", desc: "What you and each contact discuss most. Find the people aligned with what you care about right now.", icon: Hash, accent: "#06b6d4" },
  { title: "Meeting Briefs", desc: "Before every meeting: who they are, shared history, topics to raise, and what to talk about. Automatic.", icon: FileText, accent: "#ec4899" },
];

export default function LandingPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  return (
    <div className="min-h-screen text-[#e4e4e7] overflow-hidden" style={{ background: "radial-gradient(ellipse 80% 60% at 50% 40%, #0d1117 0%, #080a0f 40%, #060709 100%)" }}>
      <GrainOverlay />

      <style jsx global>{`
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(16px); filter: blur(6px); }
          to { opacity: 1; transform: translateY(0); filter: blur(0); }
        }
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        .anim-fade-in { animation: fadeIn 0.6s ease-out forwards; }
        .anim-fade-in-up { animation: fadeInUp 0.7s cubic-bezier(0.16,1,0.3,1) forwards; }
        .anim-delay-1 { animation-delay: 0.1s; opacity: 0; }
        .anim-delay-2 { animation-delay: 0.3s; opacity: 0; }
        .anim-delay-3 { animation-delay: 0.5s; opacity: 0; }
        .anim-delay-4 { animation-delay: 0.7s; opacity: 0; }
        .anim-delay-5 { animation-delay: 0.9s; opacity: 0; }
      `}</style>

      {/* ═══ NAV ═══ */}
      <nav
        className="fixed top-0 left-0 right-0 z-50 border-b border-white/[0.06] anim-fade-in anim-delay-1"
        style={{ background: "rgba(10,10,12,0.7)", backdropFilter: "blur(16px) saturate(150%)", WebkitBackdropFilter: "blur(16px) saturate(150%)" }}
      >
        <div className="max-w-[1200px] mx-auto flex items-center justify-between px-6 h-14 relative">
          <div className="flex items-center gap-2">
            <OrbitLogo size={26} />
            <span className="text-[15px] font-semibold tracking-[-0.02em] text-white">Orbit</span>
          </div>
          <div className="hidden md:flex items-center gap-7 text-[13px] text-zinc-500 absolute left-1/2 -translate-x-1/2">
            <span className="hover:text-zinc-300 transition-colors cursor-pointer">Features</span>
            <span className="hover:text-zinc-300 transition-colors cursor-pointer">How it works</span>
            <span className="hover:text-zinc-300 transition-colors cursor-pointer">Pricing</span>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/login">
              <Button variant="ghost" className="text-zinc-500 hover:text-white text-[13px] h-8 px-3">Sign in</Button>
            </Link>
            <Link href="/signup">
              <Button className="bg-white text-black hover:bg-zinc-200 text-[12px] font-semibold h-8 px-4 rounded-lg">Get started</Button>
            </Link>
          </div>
        </div>
      </nav>

      {/* ═══ HERO ═══ */}
      <section className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden">
        {/* Atmospheric color washes */}
        <div className="pointer-events-none absolute inset-0 z-[2]">
          <div className="absolute top-[-10%] left-[-5%] w-[500px] h-[500px] rounded-full" style={{ background: "radial-gradient(circle, rgba(59,130,246,0.06) 0%, transparent 60%)" }} />
          <div className="absolute top-[-5%] right-[-5%] w-[450px] h-[450px] rounded-full" style={{ background: "radial-gradient(circle, rgba(124,58,237,0.05) 0%, transparent 60%)" }} />
          <div className="absolute bottom-[-10%] left-[10%] w-[500px] h-[400px] rounded-full" style={{ background: "radial-gradient(circle, rgba(6,182,212,0.04) 0%, transparent 60%)" }} />
          <div className="absolute bottom-[-5%] right-[5%] w-[400px] h-[400px] rounded-full" style={{ background: "radial-gradient(circle, rgba(59,130,246,0.035) 0%, transparent 60%)" }} />
        </div>

        {/* Three.js scene */}
        <div className="absolute inset-0 z-[1] anim-fade-in anim-delay-1">
          {mounted && <ConstellationScene />}
        </div>

        {/* Text readability veil */}
        <div className="pointer-events-none absolute inset-0 z-[5]" style={{ background: "radial-gradient(ellipse 55% 45% at 50% 50%, rgba(6,7,9,0.55) 0%, transparent 70%)" }} />

        {/* Hero copy */}
        <div className="relative z-10 flex flex-col items-center text-center px-6 max-w-3xl">
          {/* Badge with AnimatedGradientText */}
          <div className="mb-8 anim-fade-in-up anim-delay-2">
            <span className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-black/40 px-4 py-1.5 backdrop-blur-md">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(34,197,94,0.5)]" />
              <AnimatedGradientText
                speed={0.5}
                colorFrom="#a1a1aa"
                colorTo="#3b82f6"
                className="text-[11px] tracking-[0.08em] uppercase font-medium"
              >
                Relationship Intelligence
              </AnimatedGradientText>
            </span>
          </div>

          <h1 className="text-[clamp(2.8rem,5.5vw,4.5rem)] font-bold tracking-[-0.04em] leading-[1.05] mb-6 text-white anim-fade-in-up anim-delay-3" style={{ textShadow: "0 2px 20px rgba(0,0,0,0.5), 0 0px 40px rgba(0,0,0,0.3)" }}>
            Your network is your
            <br />
            <span className="font-[family-name:var(--font-serif)] italic font-normal text-zinc-400">
              net worth
            </span>
          </h1>

          <p className="text-[16px] text-zinc-400 max-w-[460px] leading-[1.7] font-light mb-10 anim-fade-in-up anim-delay-4" style={{ textShadow: "0 1px 12px rgba(0,0,0,0.5)" }}>
            Orbit maps every relationship into a living constellation —
            surfacing warm intros, fading connections, and intelligence
            your CRM will never see.
          </p>

          <div className="flex flex-col items-center gap-3 anim-fade-in-up anim-delay-5">
            <Link href="/signup">
              <Button className="bg-white text-black hover:bg-zinc-200 text-[14px] font-semibold h-12 px-8 rounded-xl shadow-[0_0_30px_rgba(255,255,255,0.06)] hover:shadow-[0_0_40px_rgba(255,255,255,0.1)] transition-all duration-300 hover:-translate-y-0.5 group">
                Map your network
                <ArrowRight className="w-4 h-4 ml-1.5 group-hover:translate-x-0.5 transition-transform" />
              </Button>
            </Link>
            <span className="text-[11px] text-zinc-700">No credit card required</span>
          </div>
        </div>
      </section>

      {/* ═══ FEATURES with AnimatedGridPattern ═══ */}
      <section className="relative z-10 max-w-[1100px] mx-auto px-6 py-32">
        <AnimatedGridPattern
          numSquares={20}
          maxOpacity={0.03}
          duration={4}
          repeatDelay={2}
          className="absolute inset-0 z-0 [mask-image:radial-gradient(500px_circle_at_center,white,transparent)]"
        />

        <div className="relative z-10">
          <div className="text-center mb-16">
            <h2 className="text-[30px] font-bold tracking-[-0.03em] mb-3 text-white">
              Intelligence, not just{" "}
              <span className="font-[family-name:var(--font-serif)] italic font-normal text-zinc-500">contacts</span>
            </h2>
            <TextAnimate
              as="p"
              by="word"
              animation="blurIn"
              startOnView
              once
              delay={0.15}
              className="text-zinc-600 text-[15px] max-w-md mx-auto leading-relaxed"
            >
              Orbit understands the topology of your relationships — not just who you know, but how well.
            </TextAnimate>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-px rounded-2xl overflow-hidden bg-white/[0.03] border border-white/[0.04]">
            {FEATURES.map((f, i) => (
              <div key={i} className="group relative bg-[#0a0a0c] p-7 hover:bg-white/[0.01] transition-colors duration-500">
                <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" style={{ background: `radial-gradient(250px at 50% 0%, ${f.accent}06, transparent 70%)` }} />
                <div className="relative">
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center mb-4 border border-white/[0.06] bg-white/[0.02]">
                    <f.icon className="w-4 h-4" style={{ color: f.accent }} strokeWidth={1.5} />
                  </div>
                  <h3 className="text-[14px] font-semibold mb-1.5 tracking-[-0.01em] text-zinc-200 group-hover:text-white transition-colors">{f.title}</h3>
                  <p className="text-[13px] text-zinc-600 leading-[1.65] group-hover:text-zinc-500 transition-colors">{f.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ METRICS with NumberTicker ═══ */}
      <section className="relative z-10 max-w-[900px] mx-auto px-6 pb-28">
        <div className="h-px bg-gradient-to-r from-transparent via-white/[0.06] to-transparent mb-28" />
        <div className="grid grid-cols-3 gap-8">
          <div className="text-center">
            <div className="text-[36px] font-bold tracking-[-0.04em] text-white mb-1">
              <NumberTicker value={112} className="text-[36px] font-bold tracking-[-0.04em] text-white" />
              <span>+</span>
            </div>
            <div className="text-[13px] text-zinc-400 font-medium">Contacts mapped</div>
            <div className="text-[11px] text-zinc-700 mt-0.5">in first 24 hours</div>
          </div>
          <div className="text-center">
            <div className="text-[36px] font-bold tracking-[-0.04em] text-white mb-1">
              <NumberTicker value={6} className="text-[36px] font-bold tracking-[-0.04em] text-white" />
            </div>
            <div className="text-[13px] text-zinc-400 font-medium">AI agent tools</div>
            <div className="text-[11px] text-zinc-700 mt-0.5">via OpenClaw plugin</div>
          </div>
          <div className="text-center">
            <div className="text-[36px] font-bold tracking-[-0.04em] text-white mb-1">
              <NumberTicker value={2} className="text-[36px] font-bold tracking-[-0.04em] text-white" />
              <span>-hop</span>
            </div>
            <div className="text-[13px] text-zinc-400 font-medium">Intro paths</div>
            <div className="text-[11px] text-zinc-700 mt-0.5">through warm connections</div>
          </div>
        </div>
      </section>

      {/* ═══ HOW IT WORKS with Particles ═══ */}
      <section className="relative z-10 max-w-[1000px] mx-auto px-6 pb-32">
        {mounted && (
          <Particles
            className="absolute inset-0 z-0"
            quantity={30}
            staticity={80}
            ease={80}
            size={0.3}
            color="#3b82f6"
          />
        )}
        <div className="relative z-10">
          <div className="text-center mb-14">
            <h2 className="text-[28px] font-bold tracking-[-0.03em] mb-3 text-white">
              Three steps to{" "}
              <span className="font-[family-name:var(--font-serif)] italic font-normal text-zinc-500">clarity</span>
            </h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {[
              { step: "01", title: "Connect your agent", desc: "Install the OpenClaw plugin. Your AI agent starts observing conversations and pushing contacts to Orbit." },
              { step: "02", title: "Watch the graph grow", desc: "Every interaction becomes a node, every relationship an edge. The constellation builds itself." },
              { step: "03", title: "Act on intelligence", desc: "Cold alerts, warm intro paths, meeting briefs — Orbit tells you what to do and when." },
            ].map((item, i) => (
              <GlassSurface key={i} className="p-6 h-full hover:border-white/[0.1] transition-colors duration-500">
                <div className="text-[11px] font-semibold tracking-[0.15em] text-zinc-700 uppercase mb-4">{item.step}</div>
                <h3 className="text-[15px] font-semibold mb-2 text-zinc-200">{item.title}</h3>
                <p className="text-[13px] text-zinc-600 leading-[1.65]">{item.desc}</p>
              </GlassSurface>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ BOTTOM CTA with ShimmerButton ═══ */}
      <section className="relative z-10 max-w-[700px] mx-auto px-6 pb-24">
        <GlassCard className="p-14 text-center relative overflow-hidden">
          <BorderBeam size={200} duration={20} colorFrom="rgba(255,255,255,0.08)" colorTo="rgba(59,130,246,0.05)" />
          <h2 className="text-[24px] font-bold tracking-[-0.03em] mb-3 relative text-white">See your network clearly</h2>
          <p className="text-zinc-500 text-[14px] mb-8 relative">Built for founders who take relationships seriously.</p>
          <Link href="/signup" className="relative inline-block">
            <ShimmerButton
              shimmerColor="rgba(255,255,255,0.08)"
              shimmerSize="0.04em"
              shimmerDuration="4s"
              background="rgba(255,255,255,1)"
              borderRadius="12px"
              className="text-black text-[14px] font-semibold h-11 px-8"
            >
              Map your network <ArrowRight className="w-4 h-4 ml-1.5 inline" />
            </ShimmerButton>
          </Link>
        </GlassCard>
      </section>

      {/* ═══ FOOTER ═══ */}
      <footer className="relative z-10 border-t border-white/[0.04] py-8">
        <div className="max-w-[1200px] mx-auto px-6 flex items-center justify-between">
          <div className="flex items-center gap-2 text-[13px] text-zinc-700">
            <OrbitLogo size={16} />
            Orbit
          </div>
          <div className="text-[11px] text-zinc-800">&copy; 2026</div>
        </div>
      </footer>
    </div>
  );
}
