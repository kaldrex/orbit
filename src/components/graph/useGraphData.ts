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

// Reagraph / Three.js handles ~2-3k nodes comfortably on modern GPUs.
// We cap here only as a safety net against pathological datasets; real
// production networks (1,602 for Sanchay today, ~2k for a heavy user)
// render fine under this ceiling. Raise cautiously — > 5k starts to
// thrash the force-directed layout on low-end hardware.
const MAX_RENDERED_NODES = 2500;

export interface GraphDataOverlays {
  /** Per-person override fill (community-view). */
  communityColor?: Record<string, string> | null;
  /** Per-person 0..1 hub score used for size bump + ring markers. */
  hubScore?: Map<string, number> | null;
}

export function useGraphData(
  activeFilter: string,
  selfNodeId: string,
  showSelfEdges: boolean = false,
  overlays: GraphDataOverlays = {},
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

  const { communityColor, hubScore } = overlays;

  const { nodes, edges } = useMemo<{ nodes: ReagraphNode[]; edges: ReagraphEdge[] }>(() => {
    if (!raw) return { nodes: [], edges: [] };

    const allNodes = toReagraphNodes(raw.nodes, selfNodeId, {
      communityColor: communityColor ?? null,
      hubScore: hubScore ?? null,
    });
    const prunedLinks = showSelfEdges
      ? raw.links
      : raw.links.filter((l) => l.type === "knows" || (l.weight ?? 0) >= 1);
    const allEdges = toReagraphEdges(prunedLinks);

    // Cap the render pool BEFORE filtering so the dim-not-remove filter
    // can operate over the full rendered surface. Priority when capping:
    // self first, then edge-connected nodes (preserve topology), then
    // highest-score isolates. Isolates are the long-tail "other" bucket
    // with no interaction edges.
    let capped = allNodes;
    if (allNodes.length > MAX_RENDERED_NODES) {
      const connected = new Set<string>();
      for (const e of allEdges) {
        connected.add(e.source);
        connected.add(e.target);
      }
      const selfNode = allNodes.filter((n) => n.id === selfNodeId);
      const connectedNodes = allNodes.filter(
        (n) => connected.has(n.id) && n.id !== selfNodeId,
      );
      const isolateNodes = allNodes
        .filter((n) => !connected.has(n.id) && n.id !== selfNodeId)
        .sort((a, b) => b.data.score - a.data.score);
      const budget = Math.max(
        0,
        MAX_RENDERED_NODES - selfNode.length - connectedNodes.length,
      );
      capped = [...selfNode, ...connectedNodes, ...isolateNodes.slice(0, budget)];
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
  }, [raw, activeFilter, selfNodeId, showSelfEdges, communityColor, hubScore]);

  return { nodes, edges, loading, error, rawStats: raw?.stats };
}
