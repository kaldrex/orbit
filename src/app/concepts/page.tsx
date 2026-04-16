"use client";

import dynamic from "next/dynamic";
import { useState, Suspense } from "react";
import { motion, AnimatePresence } from "motion/react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import GrainOverlay from "@/components/landing/GrainOverlay";
import { ArrowRight } from "lucide-react";

const LiquidGlassOrb = dynamic(() => import("@/components/landing/concepts/LiquidGlassOrb"), { ssr: false });
const ChromeHeadline = dynamic(() => import("@/components/landing/concepts/ChromeHeadline"), { ssr: false });
const TrailRibbons = dynamic(() => import("@/components/landing/concepts/TrailRibbons"), { ssr: false });
const IridescentCluster = dynamic(() => import("@/components/landing/concepts/IridescentCluster"), { ssr: false });
const ScrollFlythrough = dynamic(() => import("@/components/landing/concepts/ScrollFlythrough"), { ssr: false });

const CONCEPTS = [
  { id: "glass-orb", label: "1 · Liquid Glass Orb", desc: "MeshDistortMaterial + Environment reflections. One dramatic organic blob.", component: LiquidGlassOrb },
  { id: "chrome-text", label: "2 · Chrome Headline", desc: "3D metallic text + Stars. Typography IS the design.", component: ChromeHeadline },
  { id: "trail-ribbons", label: "3 · Trail Ribbons", desc: "Orbiting nodes with glowing Trail ribbons. Living connections.", component: TrailRibbons },
  { id: "iridescent", label: "4 · Iridescent Cluster", desc: "Glass spheres + distortion + refraction. Luxury aesthetic.", component: IridescentCluster },
  { id: "flythrough", label: "5 · Scroll Fly-Through", desc: "Scroll drives camera through a 3D network. Interactive story.", component: ScrollFlythrough },
];

export default function ConceptShowcase() {
  const [active, setActive] = useState(0);
  const ActiveScene = CONCEPTS[active].component;

  return (
    <div className="min-h-screen bg-[#0a0a0c] text-[#e4e4e7] overflow-hidden">
      <GrainOverlay />

      <section className="relative min-h-screen flex flex-col">
        {/* 3D Scene */}
        <div className="absolute inset-0 z-[1]">
          <AnimatePresence mode="wait">
            <motion.div
              key={active}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.8 }}
              className="absolute inset-0"
            >
              <ActiveScene />
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Ambient glow */}
        <div className="pointer-events-none absolute inset-0 z-[2]">
          <div className="absolute top-[18%] left-1/2 -translate-x-1/2 w-[800px] h-[400px] rounded-full" style={{ background: "radial-gradient(ellipse, rgba(59,130,246,0.04) 0%, transparent 70%)" }} />
        </div>

        {/* Nav */}
        <nav className="relative z-20 flex items-center justify-between px-6 h-14 max-w-[1200px] mx-auto w-full">
          <div className="flex items-center gap-2.5">
            <div className="w-6 h-6 rounded-full bg-white flex items-center justify-center text-[9px] font-bold text-black">O</div>
            <span className="text-[15px] font-semibold tracking-[-0.02em] text-white">Orbit</span>
          </div>
          <Link href="/">
            <Button variant="ghost" className="text-zinc-500 hover:text-white text-[12px] h-8 px-3">
              ← Back to current
            </Button>
          </Link>
        </nav>

        {/* Hero copy — only shown for concepts that don't render their own text */}
        {active !== 1 && (
          <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-6 text-center">
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.2 }} className="mb-7">
              <span className="inline-flex items-center gap-2 rounded-full border border-white/[0.06] bg-white/[0.02] px-4 py-1.5 text-[11px] text-zinc-500 tracking-[0.08em] uppercase font-medium backdrop-blur-sm">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(34,197,94,0.5)]" />
                Relationship Intelligence
              </span>
            </motion.div>

            <motion.h1
              initial={{ opacity: 0, y: 20, filter: "blur(8px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              transition={{ duration: 0.7, delay: 0.3 }}
              className="text-[clamp(2.5rem,5vw,4.2rem)] font-bold tracking-[-0.04em] leading-[1.05] mb-5 text-white"
            >
              Your network is your
              <br />
              <span className="font-[family-name:var(--font-serif)] italic font-normal text-zinc-400">net worth</span>
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.5 }}
              className="text-[15px] text-zinc-500 max-w-[440px] leading-[1.7] font-light mb-8"
            >
              Orbit maps every relationship into a living constellation —
              surfacing warm intros, fading connections, and intelligence
              your CRM will never see.
            </motion.p>

            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.6 }}>
              <Button className="bg-white text-black hover:bg-zinc-200 text-[14px] font-semibold h-12 px-8 rounded-xl shadow-[0_0_30px_rgba(255,255,255,0.06)] transition-all duration-300 hover:-translate-y-0.5">
                Map your network <ArrowRight className="w-4 h-4 ml-1.5" />
              </Button>
            </motion.div>
          </div>
        )}

        {/* Spacer for Chrome Headline concept (text is in the 3D scene) */}
        {active === 1 && <div className="flex-1" />}

        {/* Concept selector */}
        <div className="relative z-30 pb-6 px-4">
          <div className="max-w-[1100px] mx-auto">
            <div
              className="rounded-2xl border border-white/[0.06] p-1.5 flex gap-1 overflow-x-auto"
              style={{ background: "rgba(10,10,12,0.85)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)" }}
            >
              {CONCEPTS.map((c, i) => (
                <button
                  key={c.id}
                  onClick={() => setActive(i)}
                  className={`flex-1 min-w-[130px] px-3 py-2.5 rounded-xl text-left transition-all duration-300 ${
                    active === i
                      ? "bg-white/[0.06] border border-white/[0.08]"
                      : "hover:bg-white/[0.02] border border-transparent"
                  }`}
                >
                  <div className={`text-[11px] font-semibold mb-0.5 transition-colors ${active === i ? "text-white" : "text-zinc-500"}`}>
                    {c.label}
                  </div>
                  <div className="text-[9px] text-zinc-700 leading-snug">{c.desc}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
