"use client";

import { useEffect, useMemo, useState } from "react";
import {
  buildCommunityColorMap,
  distinctCommunityCount,
  topHubs,
  type CentralityNode,
  type Community,
} from "@/lib/graph-intelligence";

interface IntelligenceState {
  communities: Community[];
  centrality: CentralityNode[];
  /** true once both endpoints have responded (success, 503, or network). */
  ready: boolean;
  /** true when the /communities route returned a payload we couldn't use. */
  unavailable: boolean;
}

/**
 * One mount-time fetch pair: /graph/communities and /graph/centrality.
 * Returns memoised lookups the Dashboard threads into the canvas.
 *
 * Degrades quietly: if Neo4j is not populated (503 with
 * `NEO4J_NOT_POPULATED`) everything empties and the UI flips to "no
 * overlay available". No exceptions, no retries.
 */
export function useGraphIntelligence() {
  const [state, setState] = useState<IntelligenceState>({
    communities: [],
    centrality: [],
    ready: false,
    unavailable: false,
  });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      let communities: Community[] = [];
      let centrality: CentralityNode[] = [];
      let unavailable = false;

      try {
        const r = await fetch("/api/v1/graph/communities");
        if (r.ok) {
          const j = await r.json();
          if (Array.isArray(j?.communities)) communities = j.communities;
        } else if (r.status === 503) {
          unavailable = true;
        }
      } catch {
        unavailable = true;
      }

      try {
        const r = await fetch("/api/v1/graph/centrality");
        if (r.ok) {
          const j = await r.json();
          if (Array.isArray(j?.nodes)) centrality = j.nodes;
        } else if (r.status === 503) {
          unavailable = true;
        }
      } catch {
        unavailable = true;
      }

      if (cancelled) return;
      setState({ communities, centrality, ready: true, unavailable });
    }

    load();
    return () => { cancelled = true; };
  }, []);

  const communityColor = useMemo(
    () => buildCommunityColorMap(state.communities),
    [state.communities],
  );
  const hubScore = useMemo(
    () => topHubs(state.centrality, 10),
    [state.centrality],
  );
  const componentCount = useMemo(
    () => distinctCommunityCount(state.communities),
    [state.communities],
  );

  return {
    ready: state.ready,
    unavailable: state.unavailable,
    communities: state.communities,
    centrality: state.centrality,
    communityColor,
    hubScore,
    componentCount,
  };
}
