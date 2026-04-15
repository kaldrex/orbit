"use client";

import type { ReagraphNode } from "@/lib/graph-transforms";
import { CATEGORY_META } from "@/lib/graph-transforms";

interface HoverCardProps {
  node: ReagraphNode | null;
  x: number;
  y: number;
}

export default function HoverCard({ node, x, y }: HoverCardProps) {
  if (!node) return null;
  const meta = CATEGORY_META[node.data.category] ?? CATEGORY_META.other;
  const cold = node.data.goingCold;

  return (
    <div
      className="pointer-events-none absolute z-30 min-w-[180px] max-w-[260px] rounded-lg border border-zinc-800 bg-[#09090b]/95 backdrop-blur-sm px-3 py-2"
      style={{
        left: Math.min(x + 14, (typeof window !== "undefined" ? window.innerWidth : 1920) - 280),
        top: Math.min(y + 14, (typeof window !== "undefined" ? window.innerHeight : 1080) - 120),
      }}
    >
      <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
        <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: meta.color }} />
        <span className="truncate">{node.label || "Unnamed"}</span>
      </div>
      {node.subLabel && (
        <div className="truncate text-xs text-zinc-500 mt-0.5">{node.subLabel}</div>
      )}
      <div className="mt-1.5 flex items-center gap-2 text-[10px] uppercase tracking-wide text-zinc-600">
        <span>{meta.label}</span>
        <span>score {node.data.score.toFixed(1)}</span>
        {cold && <span className="text-red-400">going cold</span>}
      </div>
    </div>
  );
}
