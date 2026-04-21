"use client";

import { CATEGORY_META } from "@/lib/graph-transforms";

const ORDER = [
  "self", "team", "sponsor", "fellow", "media",
  "community", "founder", "friend", "other",
] as const;

export default function CategoryLegend() {
  return (
    <div className="pointer-events-auto flex flex-col gap-1 rounded-xl border border-zinc-800/60 bg-[#09090b]/90 backdrop-blur-sm p-3">
      <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-500 mb-1">
        Legend
      </div>
      {ORDER.map((key) => {
        const meta = CATEGORY_META[key];
        if (!meta) return null;
        return (
          <div key={key} className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: meta.color }} />
            <span className="text-[11px] text-zinc-400">{meta.label}</span>
          </div>
        );
      })}
    </div>
  );
}
