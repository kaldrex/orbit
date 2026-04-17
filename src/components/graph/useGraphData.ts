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

const MAX_RENDERED_NODES = 20; // TEMP: testing if small graphs render

export function useGraphData(
  activeFilter: string,
  selfNodeId: string,
  showSelfEdges: boolean = false
) {
  const [raw, setRaw] = useState<ApiGraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/graph")
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
    const prunedLinks = showSelfEdges
      ? raw.links
      : raw.links.filter((l) => l.type === "knows" || (l.weight ?? 0) >= 1);
    const allEdges = toReagraphEdges(prunedLinks);
    let filtered = filterReagraphNodes(allNodes, activeFilter, selfNodeId);

    // Cap node count to prevent WebGL context loss on large graphs.
    // Keep self node + top N by score.
    if (filtered.length > MAX_RENDERED_NODES) {
      const self = filtered.filter((n) => n.id === selfNodeId);
      const rest = filtered
        .filter((n) => n.id !== selfNodeId)
        .sort((a, b) => b.data.score - a.data.score)
        .slice(0, MAX_RENDERED_NODES - self.length);
      filtered = [...self, ...rest];
    }

    const keep = new Set(filtered.map((n) => n.id));
    const filteredEdges = filterEdgesByNodes(allEdges, keep);
    console.log("[orbit-debug] nodes:", filtered.length, "edges:", filteredEdges.length, "sample node:", filtered[0]);
    return { nodes: filtered, edges: filteredEdges };
  }, [raw, activeFilter, selfNodeId, showSelfEdges]);

  return { nodes, edges, loading, error, rawStats: raw?.stats };
}
