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
    /** 0..1 — only populated for top-N hubs from /graph/centrality. */
    hubScore?: number;
    /** true when the node is filtered out by the active tab. We dim
     *  instead of removing so the network topology stays stable as
     *  the user pivots between filters. */
    dimmed?: boolean;
  };
}

/** Fill used for dimmed (filtered-out) nodes. Zinc-800 — visible enough
 *  to preserve topology, dark enough that matching nodes pop. */
export const DIM_FILL = "#27272a";

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

/** Minimum score for a node to be eligible for the Going Cold filter.
 *  Tuned against Sanchay's live populate output (max ~10 for self,
 *  1.4-2.8 for genuine human contacts with ≥ 2 interaction edges).
 *  `>2` catches humans with sustained two-sided conversation history while
 *  excluding single-edge long-tail contacts. The same threshold is used
 *  server-side in `/api/v1/graph` and `/api/v1/persons/going-cold`. */
export const GOING_COLD_MIN_SCORE = 2;

export function computeCold(ts: string | null, score: number): boolean {
  if (!ts || score <= GOING_COLD_MIN_SCORE) return false;
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

export interface ToReagraphOptions {
  /** personId → hex/hsl colour. Used by the "Community view" toggle to
   *  override category fill. Self-node stays white regardless. */
  communityColor?: Record<string, string> | null;
  /** personId → 0..1 hub score from /graph/centrality. Hub nodes get a
   *  1.5×–2× size bump so Sanchay can spot connectors at a glance. */
  hubScore?: Map<string, number> | null;
}

/**
 * Convert API nodes to Reagraph nodes.
 * @param selfNodeId — the current user's self-node ID (replaces hardcoded "hardeep")
 * @param opts — optional graph-intelligence overlays (community colour, hub size)
 */
export function toReagraphNodes(
  apiNodes: ApiNode[],
  selfNodeId: string,
  opts: ToReagraphOptions = {},
): ReagraphNode[] {
  const out: ReagraphNode[] = [];
  const cc = opts.communityColor ?? null;
  const hubs = opts.hubScore ?? null;
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

    const baseSize = clamp(n.score * 2.2 + 3, 4, 24);
    const hubScore = hubs?.get(n.id);
    // Top-10 hubs get a 1.5× (least-central of top-10) to 2× (most-central)
    // size bump so connectors stand out without overwhelming the canvas.
    const sizeMultiplier = hubScore === undefined ? 1 : 1.5 + 0.5 * hubScore;
    const fill = cc?.[n.id] ?? meta.color;

    const node: ReagraphNode = {
      id: n.id,
      label: n.name,
      fill,
      size: clamp(baseSize * sizeMultiplier, 4, 40),
      data: {
        score: n.score,
        category: cat,
        lastInteractionAt: n.lastInteractionAt,
        goingCold: computeCold(n.lastInteractionAt, n.score),
      },
    };
    if (hubScore !== undefined) node.data.hubScore = hubScore;
    out.push(node);
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

/** Dim-not-remove: every node stays in the array, but non-matching nodes
 *  are tagged `dimmed: true`, have their label cleared, and fall to the
 *  DIM_FILL color. This keeps the camera stable (no re-fit on filter
 *  change) and preserves network topology as the user pivots between
 *  filters. Self is never dimmed. */
export function filterReagraphNodes(
  nodes: ReagraphNode[],
  activeFilter: string,
  selfNodeId: string,
): ReagraphNode[] {
  if (!activeFilter || activeFilter === "All") {
    // "All" — clear any prior dim state in case the caller reuses nodes.
    return nodes.map((n) =>
      n.data.dimmed ? { ...n, data: { ...n.data, dimmed: false } } : n,
    );
  }
  const filterKey = activeFilter === "Going Cold"
    ? null
    : FILTER_TO_CATEGORY[activeFilter.toLowerCase()] ?? activeFilter.toLowerCase();
  const matches = (n: ReagraphNode): boolean => {
    if (n.id === selfNodeId) return true;
    if (activeFilter === "Going Cold") return n.data.goingCold;
    return n.data.category === filterKey;
  };
  return nodes.map((n) => {
    if (matches(n)) {
      return n.data.dimmed ? { ...n, data: { ...n.data, dimmed: false } } : n;
    }
    return {
      ...n,
      label: "",
      fill: DIM_FILL,
      data: { ...n.data, dimmed: true },
    };
  });
}

/** Dim-not-remove for edges: every edge stays, but edges that touch a
 *  dimmed node get shrunk to a near-invisible size so the active-filter
 *  slice visually pops without losing the rest of the graph. Pass the
 *  set of NON-DIMMED node ids. */
export function filterEdgesByNodes(
  edges: ReagraphEdge[],
  brightNodeIds: Set<string>,
): ReagraphEdge[] {
  return edges.map((e) => {
    const bothBright = brightNodeIds.has(e.source) && brightNodeIds.has(e.target);
    return bothBright ? e : { ...e, size: 0.1 };
  });
}
