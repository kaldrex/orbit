"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

/* ─── Shared suffix flip component ─── */
function FlippingSuffix({ className }: { className?: string }) {
  const [isWorth, setIsWorth] = useState(true);
  useEffect(() => {
    const iv = setInterval(() => setIsWorth((v) => !v), 3500);
    return () => clearInterval(iv);
  }, []);

  return (
    <span
      className={`inline-block overflow-hidden align-baseline ${className ?? ""}`}
      style={{ perspective: "500px" }}
    >
      <AnimatePresence mode="wait">
        <motion.span
          key={isWorth ? "worth" : "work"}
          className="inline-block"
          initial={{ rotateX: -90, opacity: 0, filter: "blur(4px)" }}
          animate={{ rotateX: 0, opacity: 1, filter: "blur(0px)" }}
          exit={{ rotateX: 90, opacity: 0, filter: "blur(4px)" }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          style={{ transformOrigin: "center bottom" }}
        >
          {isWorth ? "worth" : "work"}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/* ═══ VARIANT A: "Relationships are net worth/work" ═══ */
function VariantA() {
  return (
    <h1
      className="text-[clamp(2.8rem,5.5vw,4.5rem)] font-bold tracking-[-0.04em] leading-[1.05] text-white"
      style={{ textShadow: "0 2px 20px rgba(0,0,0,0.5)" }}
    >
      Relationships are
      <br />
      <span className="font-[family-name:var(--font-serif)] italic font-normal text-zinc-400">
        net{" "}
      </span>
      <FlippingSuffix className="font-[family-name:var(--font-serif)] italic font-normal text-zinc-400" />
    </h1>
  );
}

/* ═══ VARIANT B: "Every connection is net worth/work" ═══ */
function VariantB() {
  return (
    <h1
      className="text-[clamp(2.8rem,5.5vw,4.5rem)] font-bold tracking-[-0.04em] leading-[1.05] text-white"
      style={{ textShadow: "0 2px 20px rgba(0,0,0,0.5)" }}
    >
      Every connection is
      <br />
      <span className="font-[family-name:var(--font-serif)] italic font-normal text-zinc-400">
        net{" "}
      </span>
      <FlippingSuffix className="font-[family-name:var(--font-serif)] italic font-normal text-zinc-400" />
    </h1>
  );
}

/* ═══ VARIANT C: "The real net worth/work" ═══ */
function VariantC() {
  return (
    <h1
      className="text-[clamp(2.8rem,5.5vw,4.5rem)] font-bold tracking-[-0.04em] leading-[1.05] text-white"
      style={{ textShadow: "0 2px 20px rgba(0,0,0,0.5)" }}
    >
      The real
      <br />
      <span className="font-[family-name:var(--font-serif)] italic font-normal text-zinc-400 text-[clamp(3.2rem,6.5vw,5.5rem)]">
        net{" "}
      </span>
      <FlippingSuffix className="font-[family-name:var(--font-serif)] italic font-normal text-zinc-400 text-[clamp(3.2rem,6.5vw,5.5rem)]" />
    </h1>
  );
}

/* ═══ VARIANT D: "Grow your net worth/work" ═══ */
function VariantD() {
  return (
    <h1
      className="text-[clamp(2.8rem,5.5vw,4.5rem)] font-bold tracking-[-0.04em] leading-[1.05] text-white"
      style={{ textShadow: "0 2px 20px rgba(0,0,0,0.5)" }}
    >
      Grow your
      <br />
      <span className="font-[family-name:var(--font-serif)] italic font-normal text-zinc-400">
        net{" "}
      </span>
      <FlippingSuffix className="font-[family-name:var(--font-serif)] italic font-normal text-zinc-400" />
    </h1>
  );
}

export const HERO_VARIANTS = [
  { id: "relationships", label: "A · Relationships are", desc: "Relationships are net worth/work", component: VariantA },
  { id: "connection", label: "B · Every connection", desc: "Every connection is net worth/work", component: VariantB },
  { id: "the-real", label: "C · The real", desc: "The real net worth/work (bigger text)", component: VariantC },
  { id: "grow", label: "D · Grow your", desc: "Grow your net worth/work", component: VariantD },
];
