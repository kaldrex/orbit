"use client";

import { cn } from "@/lib/utils";

/** Gradient border shell — the HyperBase signature glass card */
export function GlassCard({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className="rounded-2xl p-px"
      style={{
        background:
          "linear-gradient(135deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0.02) 40%, rgba(255,255,255,0.0) 60%, rgba(255,255,255,0.05) 100%)",
      }}
    >
      <div
        className={cn(
          "rounded-[calc(1rem-1px)] bg-[#08080c]/70 backdrop-blur-md",
          "shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_4px_24px_rgba(0,0,0,0.3)]",
          className
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** Simpler glass surface without the gradient shell */
export function GlassSurface({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-white/[0.06] bg-white/[0.02]",
        "backdrop-blur-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]",
        className
      )}
    >
      {children}
    </div>
  );
}
