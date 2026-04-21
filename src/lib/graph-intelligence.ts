// Orbit graph-intelligence helpers.
// Types + prefix-match used by the intro-path type-ahead. The community /
// centrality helpers that used to live here were removed with their
// backing routes (Aura Graph Analytics not on our tier).

export interface GraphPathNode {
  id: string;
  name: string;
  category: string | null;
  company: string | null;
}

export interface GraphPathResponse {
  path: GraphPathNode[];
  hops: number;
  edge_types: string[];
  total_affinity: number;
}

/**
 * Prefix-match on person name for the intro-path type-ahead.
 * Case-insensitive, leading whitespace tolerant, first 8 hits max.
 */
export interface PersonLite {
  id: string;
  name: string | null;
  company?: string | null;
  category?: string | null;
}

export function matchByPrefix(
  query: string,
  persons: PersonLite[],
  limit = 8,
): PersonLite[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: PersonLite[] = [];
  for (const p of persons) {
    if (!p.name) continue;
    const n = p.name.toLowerCase();
    // Prefix on full name OR on any whitespace-split token.
    if (
      n.startsWith(q) ||
      n.split(/\s+/).some((tok) => tok.startsWith(q))
    ) {
      out.push(p);
      if (out.length >= limit) break;
    }
  }
  return out;
}
