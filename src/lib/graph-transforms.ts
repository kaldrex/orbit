// Orbit graph data transforms: API shape -> Reagraph shape.
// Ported from Hardeep's Orbit — parameterized for multi-tenant SaaS.

export interface ApiNode {
  id: string;
  name: string;
  score: number;
  category: string;
  company: string | null;
  lastInteractionAt: string | null;
}

export interface ApiLink {
  source: string;
  target: string;
  weight: number;
  type?: string;
}

export interface ApiGraphData {
  nodes: ApiNode[];
  links: ApiLink[];
  stats?: Record<string, unknown>;
}

export interface ReagraphNode {
  id: string;
  label: string;
  subLabel?: string;
  fill: string;
  size: number;
  data: {
    score: number;
    category: string;
    lastInteractionAt: string | null;
    goingCold: boolean;
  };
}

export interface ReagraphEdge {
  id: string;
  source: string;
  target: string;
  size: number;
  interpolation: "linear" | "curved";
  dashed?: boolean;
  data: { type: string };
}

export interface CategoryMeta {
  color: string;
  label: string;
}

// 9-category palette reconciled with real enrichment data (2026-04-20).
// Removed: investor/press/gov — zero occurrences in Sanchay's corpus and
// observer rarely emits them. If real data produces these, they fall
// through to `other` until a palette refresh.
export const CATEGORY_META: Record<string, CategoryMeta> = {
  self:              { color: "#FFFFFF", label: "Self" },
  team:              { color: "#E4E4E7", label: "Team" },
  sponsor:           { color: "#22C55E", label: "Sponsor" },
  fellow:            { color: "#EAB308", label: "Fellow" },
  media:             { color: "#EC4899", label: "Media" },
  community:         { color: "#06B6D4", label: "Community" },
  founder:           { color: "#F97316", label: "Founder" },
  friend:            { color: "#14B8A6", label: "Friend" },
  other:             { color: "#52525B", label: "Other" },
};

export function computeCold(ts: string | null, score: number): boolean {
  if (!ts || score <= 5) return false;
  try {
    return Date.now() - Date.parse(ts) > 14 * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

function isJunkName(name: string): boolean {
  if (!name) return true;
  if (/^\+?\d[\d\s\-().]{5,}$/.test(name)) return true;
  if (name.includes("@")) return true;
  if (/^\d{10,}$/.test(name.replace(/\D/g, ""))) return true;
  return false;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Convert API nodes to Reagraph nodes.
 * @param selfNodeId — the current user's self-node ID (replaces hardcoded "hardeep")
 */
export function toReagraphNodes(apiNodes: ApiNode[], selfNodeId: string): ReagraphNode[] {
  const out: ReagraphNode[] = [];
  for (const n of apiNodes) {
    if (isJunkName(n.name)) continue;
    const cat = n.category || "other";
    const meta = CATEGORY_META[cat] || CATEGORY_META.other;

    if (n.id === selfNodeId) {
      out.push({
        id: n.id,
        label: n.name,
        fill: "#FFFFFF",
        size: 22,
        data: {
          score: n.score,
          category: "self",
          lastInteractionAt: n.lastInteractionAt,
          goingCold: false,
        },
      });
      continue;
    }

    // Always show name. Score controls node size, not label visibility.
    out.push({
      id: n.id,
      label: n.name,
      fill: meta.color,
      size: clamp(n.score * 2.2 + 3, 4, 24),
      data: {
        score: n.score,
        category: cat,
        lastInteractionAt: n.lastInteractionAt,
        goingCold: computeCold(n.lastInteractionAt, n.score),
      },
    });
  }
  return out;
}

export function toReagraphEdges(apiLinks: ApiLink[]): ReagraphEdge[] {
  const out: ReagraphEdge[] = [];
  const counts = new Map<string, number>();
  for (const l of apiLinks) {
    const t = l.type ?? "interacted";
    const base = `${l.source}->${l.target}:${t}`;
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    const id = n === 0 ? base : `${base}#${n}`;
    out.push({
      id,
      source: l.source,
      target: l.target,
      size: Math.max(0.25, Math.log((l.weight ?? 1) + 1) * 1.5),
      interpolation: t === "knows" ? "linear" : "curved",
      dashed: t === "knows",
      data: { type: t },
    });
  }
  return out;
}

export const FILTER_TO_CATEGORY: Record<string, string> = {
  sponsors: "sponsor",
  fellows: "fellow",
  team: "team",
  media: "media",
  community: "community",
  founders: "founder",
  friends: "friend",
};

export function filterReagraphNodes(
  nodes: ReagraphNode[],
  activeFilter: string,
  selfNodeId: string
): ReagraphNode[] {
  if (!activeFilter || activeFilter === "All") return nodes;
  if (activeFilter === "Going Cold") {
    return nodes.filter((n) => n.data.goingCold || n.id === selfNodeId);
  }
  const key = FILTER_TO_CATEGORY[activeFilter.toLowerCase()] ?? activeFilter.toLowerCase();
  return nodes.filter((n) => n.data.category === key || n.id === selfNodeId);
}

export function filterEdgesByNodes(
  edges: ReagraphEdge[],
  nodeIds: Set<string>
): ReagraphEdge[] {
  return edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
}
