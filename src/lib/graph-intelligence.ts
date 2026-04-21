// Orbit graph-intelligence helpers.
// Pure functions powering the Dashboard's community/centrality overlays.
// Intentionally decoupled from the Reagraph shape so they can be unit-tested
// without mounting WebGL.

export interface CentralityNode {
  id: string;
  name: string;
  category: string | null;
  betweenness: number;
  degree: number;
}

export interface CentralityResponse {
  nodes: CentralityNode[];
}

export interface Community {
  id: string | number;
  size: number;
  member_ids: string[];
  top_names: string[];
}

export interface CommunitiesResponse {
  communities: Community[];
}

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
 * Deterministic HSL from a community id (string or number). Picks a hue
 * uniformly on the colour wheel; keeps saturation+lightness inside a band
 * that reads against both light and dark canvases.
 */
export function communityColorFromId(
  id: string | number,
  opts: { saturation?: number; lightness?: number } = {},
): string {
  const sat = opts.saturation ?? 68;
  const light = opts.lightness ?? 58;
  const s = String(id);
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return `hsl(${hue}, ${sat}%, ${light}%)`;
}

/**
 * Build a personId → communityColor lookup. Communities of size 1 are
 * deliberately not colored (they add visual noise without insight).
 */
export function buildCommunityColorMap(
  communities: Community[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of communities) {
    if (!c.member_ids || c.size < 2) continue;
    const color = communityColorFromId(c.id);
    for (const pid of c.member_ids) {
      out[pid] = color;
    }
  }
  return out;
}

/**
 * Score map (personId → normalised 0..1 hub score) from centrality rows.
 * Only the top N by betweenness are returned — those are the nodes the
 * canvas will bump in size + optionally ring.
 */
export function topHubs(
  rows: CentralityNode[],
  topN = 10,
): Map<string, number> {
  if (!rows.length) return new Map();
  const sorted = [...rows].sort((a, b) => b.betweenness - a.betweenness);
  const head = sorted.slice(0, Math.max(0, topN));
  const maxB = head[0]?.betweenness || 1;
  const m = new Map<string, number>();
  for (const r of head) {
    // Normalise to 0..1; guard against zero denominator.
    m.set(r.id, maxB > 0 ? r.betweenness / maxB : 1);
  }
  return m;
}

/**
 * Count how many connected components (communities) are present. Used by
 * the Dashboard to disable the community toggle when the graph is too
 * sparse for colouring to mean anything.
 */
export function distinctCommunityCount(communities: Community[]): number {
  return communities.filter((c) => c.size >= 2).length;
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
