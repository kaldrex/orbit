"use client";

import { Button } from "@/components/ui/button";

export type LayoutKey = "radialOut2d" | "circular2d" | "forceDirected" | "forceAtlas2";
export type SizingKey = "attribute" | "pagerank" | "centrality";

interface GraphControlsProps {
  layout: LayoutKey;
  onLayoutChange: (l: LayoutKey) => void;
  sizing: SizingKey;
  onSizingChange: (s: SizingKey) => void;
  clusterOn: boolean;
  onToggleCluster: () => void;
  clusterDisabled?: boolean;
  onFit: () => void;
}

const LAYOUTS: { key: LayoutKey; label: string }[] = [
  { key: "radialOut2d", label: "Radial" },
  { key: "circular2d", label: "Circle" },
  { key: "forceDirected", label: "Force" },
  { key: "forceAtlas2", label: "Atlas2" },
];

const SIZINGS: { key: SizingKey; label: string }[] = [
  { key: "attribute", label: "Score" },
  { key: "pagerank", label: "PageRank" },
  { key: "centrality", label: "Centrality" },
];

export default function GraphControls(props: GraphControlsProps) {
  return (
    <div className="pointer-events-auto flex flex-col gap-2 rounded-xl border border-zinc-800/60 bg-[#09090b]/90 backdrop-blur-sm p-2">
      <div className="flex items-center gap-1">
        <select
          value={props.layout}
          onChange={(e) => props.onLayoutChange(e.target.value as LayoutKey)}
          className="h-7 rounded-md border border-zinc-800 bg-zinc-900 px-2 text-[11px] text-zinc-300"
        >
          {LAYOUTS.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
        </select>
      </div>
      <div className="flex items-center gap-1">
        <select
          value={props.sizing}
          onChange={(e) => props.onSizingChange(e.target.value as SizingKey)}
          className="h-7 rounded-md border border-zinc-800 bg-zinc-900 px-2 text-[11px] text-zinc-300"
        >
          {SIZINGS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </div>
      <Button
        variant={props.clusterOn ? "default" : "outline"}
        className="h-7 text-[11px] px-2 border-zinc-800"
        onClick={props.onToggleCluster}
        disabled={props.clusterDisabled}
      >
        Cluster
      </Button>
      <Button variant="outline" className="h-7 text-[11px] px-2 border-zinc-800" onClick={props.onFit}>
        Fit
      </Button>
    </div>
  );
}
