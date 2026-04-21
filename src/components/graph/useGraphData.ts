"use client";

import { useEffect, useMemo, useState } from "react";
import {
  type ApiGraphData,
  type ReagraphEdge,
  type ReagraphNode,
  filterEdgesByNodes,
  filterReagraphNodes,
  toReagraphEdges,
  toReagraphNodes,
} from "@/lib/graph-transforms";

// Force-directed layout is O(n²) per tick (with Barnes-Hut O(n log n))
// and each node allocates Three.js geometry + a text label sprite. At
// 1,600 nodes the layout hangs the tab 10–30s before settling.
// Sanchay's real data: 144 edge-connected nodes + 1,458 isolates (phone
// contacts with zero DM/email signal). The isolates contribute nothing
// to the visual — they're a cloud of disconnected points. Cap the
// render pool to the connected core + a small slice of high-score
// isolates so the graph stays responsive. Full person list is still
// browsable via the (future) /persons list view + PersonPanel.
const MAX_RENDERED_NODES = 200;

export function useGraphData(
  activeFilter: string,
  selfNodeId: string,
  showSelfEdges: boolean = false,
) {
  const [raw, setRaw] = useState<ApiGraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/graph")
      .then((r) => r.json())
      .then((d: ApiGraphData) => {
        if (cancelled) return;
        d.nodes = d.nodes.map((n) => ({ ...n, category: n.category || "other" }));
        setRaw(d);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const { nodes, edges } = useMemo<{ nodes: ReagraphNode[]; edges: ReagraphEdge[] }>(() => {
    if (!raw) return { nodes: [], edges: [] };

    const allNodes = toReagraphNodes(raw.nodes, selfNodeId);
    // Keep every edge with a positive weight. The old >= 1 threshold
    // hid 123 of 160 real connections because our weights are log-based
    // and typically fractional.
    const prunedLinks = showSelfEdges
      ? raw.links
      : raw.links.filter((l) => l.type === "knows" || (l.weight ?? 0) > 0);
    const allEdges = toReagraphEdges(prunedLinks);

    // Render ONLY the connected core — self + nodes with edges. Isolates
    // (contacts with zero DM/email signal) dropped entirely. Two reasons:
    //   1. Radial / tree layouts NaN-poison Three.js for nodes
    //      unreachable from the root; isolates are always unreachable.
    //   2. Isolates are visually uninteresting — a cloud of disconnected
    //      points that doesn't convey anything. List view (post-V1) is
    //      the right home for them.
    const connected = new Set<string>();
    for (const e of allEdges) {
      connected.add(e.source);
      connected.add(e.target);
    }
    const selfNode = allNodes.filter((n) => n.id === selfNodeId);
    const connectedNodes = allNodes.filter(
      (n) => connected.has(n.id) && n.id !== selfNodeId,
    );
    let capped: ReagraphNode[] = [...selfNode, ...connectedNodes];
    // Safety net — shouldn't trigger in real data, but cap if a future
    // dataset has >MAX_RENDERED_NODES connected persons.
    if (capped.length > MAX_RENDERED_NODES) {
      capped = capped
        .sort((a, b) => b.data.score - a.data.score)
        .slice(0, MAX_RENDERED_NODES);
    }

    // Dim-not-remove filter: tag non-matching nodes as dimmed but keep
    // them in the array so the node set size is stable across filter
    // changes (prevents reagraph's camera from re-fitting on every tab).
    const filtered = filterReagraphNodes(capped, activeFilter, selfNodeId);
    const bright = new Set(
      filtered.filter((n) => !n.data.dimmed).map((n) => n.id),
    );
    const filteredEdges = filterEdgesByNodes(allEdges, bright);
    return { nodes: filtered, edges: filteredEdges };
  }, [raw, activeFilter, selfNodeId, showSelfEdges]);

  return { nodes, edges, loading, error, rawStats: raw?.stats };
}
