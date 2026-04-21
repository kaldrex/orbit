import { NextResponse } from "next/server";
import { getAgentOrSessionAuth } from "@/lib/api-auth";
import { withReadSession } from "@/lib/neo4j";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

const UUID_RE = /^[0-9a-f-]{36}$/i;
const MAX_HOPS = 4;

interface PathNode {
  id: string;
  name: string | null;
  category: string | null;
  company: string | null;
}

/**
 * GET /api/v1/graph/path/:from/:to
 *
 * Unweighted shortest intro-path between two persons across the user's
 * DM / SHARED_GROUP / EMAILED subgraph. Pure Cypher — no GDS required
 * (Aura Graph Analytics is a separate tier and not enabled on this
 * project). total_affinity is the sum of edge `weight` along the
 * returned path, included as a "warmness" score even though the path
 * itself is chosen by hop count, not weight.
 *
 * Response: { path, hops, edge_types, total_affinity }
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ from: string; to: string }> },
) {
  const { from, to } = await params;

  if (!UUID_RE.test(from) || !UUID_RE.test(to)) {
    return NextResponse.json(
      { error: { code: "INVALID_ID", message: "invalid person id" } },
      { status: 400 },
    );
  }

  const auth = await getAgentOrSessionAuth(request);
  if (!auth) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 },
    );
  }

  try {
    const result = await withReadSession(async (session) => {
      const existsRes = await session.run(
        `MATCH (p:Person {user_id: $uid})
         WHERE p.id IN [$from, $to]
         RETURN p.id AS id`,
        { uid: auth.userId, from, to },
      );
      const foundIds = new Set(existsRes.records.map((r) => String(r.get("id"))));
      if (!foundIds.has(from) || !foundIds.has(to)) {
        return { kind: "not_found" as const };
      }

      if (from === to) {
        const selfRes = await session.run(
          `MATCH (p:Person {id: $id, user_id: $uid})
           RETURN p.id AS id, p.name AS name, p.category AS category, p.company AS company`,
          { id: from, uid: auth.userId },
        );
        const rec = selfRes.records[0];
        if (!rec) return { kind: "not_found" as const };
        return {
          kind: "ok" as const,
          path: [
            {
              id: String(rec.get("id")),
              name: strOrNull(rec.get("name")),
              category: strOrNull(rec.get("category")),
              company: strOrNull(rec.get("company")),
            },
          ],
          hops: 0,
          edge_types: [] as string[],
          total_affinity: 0,
        };
      }

      const pathRes = await session.run(
        `MATCH (source:Person {id: $from, user_id: $uid}),
               (target:Person {id: $to, user_id: $uid})
         MATCH path = shortestPath((source)-[*1..${MAX_HOPS}]-(target))
         WHERE all(n IN nodes(path) WHERE n.user_id = $uid)
         RETURN
           [n IN nodes(path) | {
             id: n.id, name: n.name, category: n.category, company: n.company
           }] AS pathNodes,
           length(path) AS hops,
           [r IN relationships(path) | {type: type(r), weight: r.weight}] AS edges
         LIMIT 1`,
        { from, to, uid: auth.userId },
      );

      if (pathRes.records.length === 0) {
        return { kind: "no_path" as const };
      }

      const rec = pathRes.records[0];
      const rawNodes = (rec.get("pathNodes") as Array<Record<string, unknown>>) ?? [];
      const hops = numOf(rec.get("hops"));
      const rawEdges = (rec.get("edges") as Array<Record<string, unknown>>) ?? [];

      const path: PathNode[] = rawNodes.map((n) => ({
        id: String(n.id),
        name: strOrNull(n.name),
        category: strOrNull(n.category),
        company: strOrNull(n.company),
      }));
      const edge_types = rawEdges.map((e) => strOrNull(e.type) ?? "unknown");
      const total_affinity = rawEdges.reduce(
        (sum, e) => sum + numOf(e.weight),
        0,
      );

      return {
        kind: "ok" as const,
        path,
        hops,
        edge_types,
        total_affinity,
      };
    });

    if (result.kind === "not_found") {
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: "person not found" } },
        { status: 404 },
      );
    }
    if (result.kind === "no_path") {
      return NextResponse.json(
        { error: { code: "NO_PATH", message: "no path within max hops" } },
        { status: 404 },
      );
    }
    return NextResponse.json({
      path: result.path,
      hops: result.hops,
      edge_types: result.edge_types,
      total_affinity: result.total_affinity,
    });
  } catch (err) {
    const code = (err as { code?: string })?.code ?? "";
    const msg = String((err as Error)?.message ?? "").toLowerCase();
    const unreachable =
      code === "ServiceUnavailable" ||
      code === "SessionExpired" ||
      msg.includes("connection") ||
      msg.includes("unavailable") ||
      msg.includes("serviceunavailable") ||
      msg.includes("bolt");
    if (unreachable) {
      return NextResponse.json(
        { error: { code: "NEO4J_UNREACHABLE", message: "Neo4j unreachable" } },
        { status: 503 },
      );
    }
    console.error("[graph/path] error", err);
    return NextResponse.json(
      { error: { code: "INTERNAL", message: "path query failed" } },
      { status: 500 },
    );
  }
}

function strOrNull(v: unknown): string | null {
  if (v == null) return null;
  return String(v);
}

function numOf(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "object" && v !== null && "toNumber" in (v as object)) {
    try {
      return (v as { toNumber: () => number }).toNumber();
    } catch {
      return 0;
    }
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
