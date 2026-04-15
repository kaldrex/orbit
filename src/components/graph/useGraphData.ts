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
    // Show all edges. For large graphs (500+), consider filtering low-weight ones.
    const prunedLinks = showSelfEdges
      ? raw.links
      : raw.links.filter((l) => l.type === "knows" || (l.weight ?? 0) >= 1);
    const allEdges = toReagraphEdges(prunedLinks);
    const filtered = filterReagraphNodes(allNodes, activeFilter, selfNodeId);
    const keep = new Set(filtered.map((n) => n.id));
    const filteredEdges = filterEdgesByNodes(allEdges, keep);
    return { nodes: filtered, edges: filteredEdges };
  }, [raw, activeFilter, selfNodeId, showSelfEdges]);

  return { nodes, edges, loading, error, rawStats: raw?.stats };
}
