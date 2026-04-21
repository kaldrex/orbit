"use client";

import { CATEGORY_META } from "@/lib/graph-transforms";
import type { PathState } from "./IntroPathSearch";

interface PathStripProps {
  state: PathState;
  isDark: boolean;
  onDismiss: () => void;
}

function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0]?.toUpperCase() ?? "?";
  return `${parts[0][0] ?? ""}${parts[parts.length - 1][0] ?? ""}`.toUpperCase();
}

/**
 * Horizontal strip of circles + labelled connectors, rendered above the
 * bottom footer by Dashboard. Absolute-positioned relative to the main
 * graph area.
 */
export default function PathStrip({ state, isDark, onDismiss }: PathStripProps) {
  if (state.kind === "idle") return null;

  const panelBase = "pointer-events-auto rounded-xl border px-4 py-3 backdrop-blur-sm";
  const panelStyle = isDark
    ? "bg-[#09090b]/92 border-zinc-800 text-zinc-200"
    : "bg-white/92 border-zinc-200 text-zinc-800";

  const lineColor = isDark ? "bg-zinc-700" : "bg-zinc-300";
  const edgeLabelColor = isDark ? "text-zinc-500" : "text-zinc-500";

  if (state.kind === "loading") {
    return (
      <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 z-30">
        <div className={`${panelBase} ${panelStyle} text-[11px]`}>
          Finding intro path to {state.target}...
        </div>
      </div>
    );
  }

  if (state.kind === "miss") {
    return (
      <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 z-30">
        <div className={`${panelBase} ${panelStyle} text-[11px]`}>{state.message}</div>
      </div>
    );
  }

  const { path, edge_types, hops, total_affinity } = state.data;

  return (
    <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 z-30 max-w-[92%]">
      <div className={`${panelBase} ${panelStyle}`}>
        <div className="flex items-center justify-between mb-2 gap-4">
          <div className="text-[10px] uppercase tracking-wider opacity-70">
            Intro path · {hops} hops · affinity {total_affinity.toFixed(1)}
          </div>
          <button
            onClick={onDismiss}
            aria-label="Clear intro path"
            className="text-[12px] leading-none opacity-60 hover:opacity-100"
          >
            &times;
          </button>
        </div>
        <div className="flex items-center gap-1 overflow-x-auto">
          {path.map((p, i) => {
            const cat = p.category ?? "other";
            const meta = CATEGORY_META[cat] ?? CATEGORY_META.other;
            const edge = i < path.length - 1 ? edge_types[i] : null;
            return (
              <div key={p.id} className="flex items-center gap-1 shrink-0">
                <div className="flex flex-col items-center gap-0.5">
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-semibold text-black border"
                    style={{
                      backgroundColor: meta.color,
                      borderColor: isDark ? "#000" : "#fff",
                    }}
                    title={`${p.name}${p.company ? ` · ${p.company}` : ""}`}
                  >
                    {initials(p.name)}
                  </div>
                  <div className="text-[9px] max-w-[68px] truncate opacity-80">
                    {p.name}
                  </div>
                </div>
                {edge && (
                  <div className="flex flex-col items-center gap-0.5 px-1">
                    <div className={`h-[1px] w-10 ${lineColor}`} />
                    <div className={`text-[8px] uppercase tracking-wider ${edgeLabelColor}`}>
                      {edge.replace(/_/g, " ").toLowerCase()}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
