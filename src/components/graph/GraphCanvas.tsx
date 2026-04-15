"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  GraphCanvas as ReagraphCanvas,
  type GraphCanvasRef,
  type LayoutTypes,
  type SizingType,
  useSelection,
} from "reagraph";

import { orbitDarkTheme, orbitLightTheme } from "@/lib/reagraph-theme";
import type { ReagraphNode } from "@/lib/graph-transforms";
import { useGraphData } from "./useGraphData";
import GraphControls, { type LayoutKey, type SizingKey } from "./GraphControls";
import HoverCard from "./HoverCard";
import CategoryLegend from "./CategoryLegend";

interface GraphCanvasProps {
  onSelectPerson: (id: string) => void;
  activeFilter: string;
  selfNodeId: string;
  isDark?: boolean;
}

function resolveLayoutType(key: LayoutKey): LayoutTypes {
  switch (key) {
    case "forceAtlas2":
      return "forceatlas2" as LayoutTypes;
    default:
      return "forceDirected2d" as LayoutTypes;
  }
}

export default function GraphCanvas({
  onSelectPerson,
  activeFilter,
  selfNodeId,
  isDark = true,
}: GraphCanvasProps) {
  const graphRef = useRef<GraphCanvasRef | null>(null);
  const [layout, setLayout] = useState<LayoutKey>("forceDirected");
  const [sizing, setSizing] = useState<SizingKey>("attribute");
  const [clusterOn, setClusterOn] = useState(false);
  const [hover, setHover] = useState<{ node: ReagraphNode | null; x: number; y: number }>({
    node: null, x: 0, y: 0,
  });

  const { nodes, edges, loading, error } = useGraphData(activeFilter, selfNodeId);

  // Auto-fit on load + filter change
  useEffect(() => {
    if (loading || nodes.length === 0 || !graphRef.current) return;
    const id = setTimeout(() => {
      graphRef.current?.centerGraph?.();
      graphRef.current?.zoomIn?.();
    }, 400);
    return () => clearTimeout(id);
  }, [loading, nodes.length, activeFilter]);

  const layoutType = resolveLayoutType(layout);
  const clusterActive = clusterOn && layout === "forceDirected";

  const {
    selections,
    actives,
    onNodeClick: selOnNodeClick,
    onCanvasClick: selOnCanvasClick,
    onNodePointerOver: selOnPointerOver,
    onNodePointerOut: selOnPointerOut,
  } = useSelection({
    ref: graphRef,
    nodes: nodes as unknown as Parameters<typeof useSelection>[0]["nodes"],
    edges: edges as unknown as Parameters<typeof useSelection>[0]["edges"],
    type: "multiModifier",
    pathSelectionType: "out",
    pathHoverType: "out",
    focusOnSelect: false,
  });

  const onNodeClick = useCallback(
    (node: { id: string }) => {
      selOnNodeClick?.(node as unknown as Parameters<typeof selOnNodeClick>[0]);
      onSelectPerson(node.id);
    },
    [selOnNodeClick, onSelectPerson]
  );

  const onNodePointerOver = useCallback(
    (node: { id: string }, event?: { nativeEvent?: PointerEvent } | PointerEvent) => {
      selOnPointerOver?.(node as unknown as Parameters<typeof selOnPointerOver>[0]);
      const full = nodes.find((n) => n.id === node.id) ?? null;
      const native = (event as { nativeEvent?: PointerEvent })?.nativeEvent ?? (event as PointerEvent | undefined);
      setHover({ node: full, x: native?.clientX ?? 0, y: native?.clientY ?? 0 });
    },
    [selOnPointerOver, nodes]
  );

  const onNodePointerOut = useCallback(
    (node: { id: string }) => {
      selOnPointerOut?.(node as unknown as Parameters<typeof selOnPointerOut>[0]);
      setHover({ node: null, x: 0, y: 0 });
    },
    [selOnPointerOut]
  );

  const theme = isDark ? orbitDarkTheme : orbitLightTheme;
  const bgColor = isDark ? "#09090b" : "#fafafa";

  // Empty state — no data yet
  if (!loading && nodes.length <= 1) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-[var(--graph-bg)]">
        <div className="text-center max-w-sm">
          <div className="relative w-16 h-16 mx-auto mb-6">
            <div className="absolute inset-0 rounded-full border border-zinc-800 animate-spin" style={{ animationDuration: "10s" }}>
              <div className="absolute -top-[3px] left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-zinc-500" />
            </div>
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-2.5 h-2.5 rounded-full bg-white shadow-[0_0_12px_rgba(255,255,255,0.2)]" />
            </div>
          </div>
          <p className="text-[14px] text-zinc-400 mb-1">No contacts yet</p>
          <p className="text-[12px] text-zinc-600">Add contacts to see your constellation</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full" style={{ background: bgColor }}>
      {error ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-400">
            Failed to load graph: {error}
          </div>
        </div>
      ) : loading ? (
        <div className="absolute inset-0 flex items-center justify-center text-zinc-500 text-sm">
          Loading constellation...
        </div>
      ) : (
        <ReagraphCanvas
          ref={graphRef}
          nodes={nodes}
          edges={edges}
          theme={theme}
          animated
          layoutType={layoutType}
          sizingType={sizing as SizingType}
          sizingAttribute={sizing === "attribute" ? "score" : undefined}
          labelType="nodes"
          minNodeSize={4}
          maxNodeSize={28}
          defaultNodeSize={8}
          cameraMode="pan"
          draggable
          clusterAttribute={clusterActive ? "category" : undefined}
          selections={selections}
          actives={actives}
          onNodeClick={onNodeClick}
          onCanvasClick={selOnCanvasClick}
          onNodePointerOver={onNodePointerOver}
          onNodePointerOut={onNodePointerOut}
        />
      )}

      <HoverCard node={hover.node} x={hover.x} y={hover.y} />

      <div className="pointer-events-none absolute bottom-4 left-4 z-20">
        <GraphControls
          layout={layout}
          onLayoutChange={setLayout}
          sizing={sizing}
          onSizingChange={setSizing}
          clusterOn={clusterActive}
          onToggleCluster={() => setClusterOn((v) => !v)}
          clusterDisabled={layout !== "forceDirected"}
          onFit={() => graphRef.current?.centerGraph()}
        />
      </div>

      <div className="pointer-events-none absolute top-4 right-4 z-20">
        <CategoryLegend />
      </div>
    </div>
  );
}
