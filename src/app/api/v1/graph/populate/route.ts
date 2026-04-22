import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAgentOrSessionAuth } from "@/lib/api-auth";
import { withWriteSession } from "@/lib/neo4j";
import {
  ensureIndexes,
  mergeNodes,
  mergeEdges,
  pruneStaleEdges,
  pruneStaleNodes,
  computeWeight,
  computeSharedGroupWeight,
  recomputeScores,
  type GraphNode,
  type GraphEdge,
} from "@/lib/neo4j-writes";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// ---------------------------------------------------------------------------
// POST /api/v1/graph/populate
//
// Server-side rebuild of the Neo4j projection for the authed user.
// Reads Postgres (source of truth), MERGEs nodes + edges, prunes stale.
//
// Auth: Bearer-or-session (Bearer preferred for automation).
// Idempotent: re-running yields the same graph state (MERGE + prune).
//
// Edges are derived from what Postgres actually carries today:
//   - DM (WhatsApp 1:1): raw_events thread_id like '...@s.whatsapp.net'
//     + phone->person lookup. Self-person one end, other-person the other.
//   - SHARED_GROUP (WhatsApp group): raw_events thread_id like '...@g.us'.
//     Coverage is bounded -- most group senders appear as @lid-only and
//     cannot be mapped to persons without a lid->phone bridge. The rows
//     where participant_phones is populated (~5% of group msgs) do map.
//   - EMAILED (Gmail): interaction observations with channel='email'.
//     Self-person <-> linked-person per-thread totals.
//
// Returns: { nodes_written, edges_written, elapsed_ms, breakdown }
// ---------------------------------------------------------------------------

type EdgeBreakdown = { dm: number; shared_group: number; emailed: number };

interface GraphNodeRow {
  id: string;
  name: string | null;
  category: string | null;
  company: string | null;
  title: string | null;
  relationship_to_me: string | null;
  phone_count: number;
  email_count: number;
  first_seen: string | null;
  last_seen: string | null;
}

interface PhonePersonRow {
  phone: string;
  person_id: string;
}

interface DmThreadRow {
  thread_phone: string;
  msg_count: number;
  first_at: string;
  last_at: string;
}

interface GroupThreadPhoneRow {
  thread_id: string;
  phone: string;
  last_at: string;
  msg_count: number;
}

interface GroupThreadLidRow {
  thread_id: string;
  lid: string;
  last_at: string;
  msg_count: number;
}

interface LidPhoneRow {
  lid: string;
  phone: string;
}

interface EmailInteractionRow {
  person_id: string;
  msg_count: number;
  first_at: string;
  last_at: string;
}

function findSelfPersonId(
  nodes: GraphNodeRow[],
  phoneMap: Map<string, string>,
  selfEmail: string | undefined,
  selfPhone: string | undefined,
): string | null {
  // Phone match wins if configured.
  if (selfPhone && phoneMap.has(selfPhone)) {
    return phoneMap.get(selfPhone) ?? null;
  }
  // Fall back to email match: scan nodes for one whose fold includes
  // the self email. The RPC doesn't return emails[], so we match on
  // name heuristically -- or the row whose name matches the env
  // ORBIT_SELF_EMAIL prefix is our best guess. For cleanliness we
  // accept that V0 may simply have a null self, in which case DM /
  // EMAILED edges won't be emitted (SHARED_GROUP still works).
  if (selfEmail) {
    const prefix = selfEmail.split("@")[0]?.toLowerCase();
    if (prefix) {
      for (const n of nodes) {
        if (n.name && n.name.toLowerCase().startsWith(prefix.slice(0, 6))) {
          return n.id;
        }
      }
    }
  }
  return null;
}

export async function POST(request: Request) {
  const t0 = Date.now();

  const auth = await getAgentOrSessionAuth(request);
  if (!auth) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 },
    );
  }

  const userId = auth.userId;

  // ---------- Step 1: read Postgres ----------

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim(),
  );

  // PostgREST caps SETOF RPC responses at 1000 rows by default. For the
  // node RPC (can exceed 1000 on large tenants) we page by cursor; the
  // edge RPCs are bounded well under the cap by thread/interaction
  // cardinality on V0 data.
  const PAGE_SIZE = 1000;
  const nodeRows: GraphNodeRow[] = [];
  let cursor: string | null = null;
  // Loop guarded against runaway -- person tables aren't expected to
  // exceed 1M in V0.
  for (let i = 0; i < 1000; i += 1) {
    const page = await supabase.rpc("select_graph_nodes", {
      p_user_id: userId,
      p_cursor: cursor,
      p_limit: PAGE_SIZE,
    });
    if (page.error) {
      console.error(`[graph/populate] select_graph_nodes rpc error`, page.error);
      return NextResponse.json(
        { error: { code: "READ_FAILED", message: `rpc select_graph_nodes failed` } },
        { status: 502 },
      );
    }
    const rows = (page.data ?? []) as GraphNodeRow[];
    nodeRows.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    cursor = rows[rows.length - 1].id;
  }

  const [phoneMapRes, dmRes, groupRes, groupLidRes, lidMapRes, emailRes] = await Promise.all([
    supabase.rpc("select_phone_person_map", { p_user_id: userId }),
    supabase.rpc("select_dm_thread_stats", { p_user_id: userId }),
    supabase.rpc("select_group_thread_phones", { p_user_id: userId }),
    supabase.rpc("select_group_thread_lids", { p_user_id: userId }),
    supabase.rpc("select_lid_phone_map", { p_user_id: userId }),
    supabase.rpc("select_email_interactions", { p_user_id: userId }),
  ]);

  for (const [label, res] of [
    ["select_phone_person_map", phoneMapRes],
    ["select_dm_thread_stats", dmRes],
    ["select_group_thread_phones", groupRes],
    ["select_group_thread_lids", groupLidRes],
    ["select_lid_phone_map", lidMapRes],
    ["select_email_interactions", emailRes],
  ] as const) {
    if (res.error) {
      console.error(`[graph/populate] ${label} rpc error`, res.error);
      return NextResponse.json(
        { error: { code: "READ_FAILED", message: `rpc ${label} failed` } },
        { status: 502 },
      );
    }
  }

  // select_phone_person_map returns jsonb (a json array) instead of
  // SETOF (which PostgREST caps at 1000) because the phone table can
  // comfortably exceed 1k rows on larger tenants.
  const phoneRows = (Array.isArray(phoneMapRes.data)
    ? (phoneMapRes.data as PhonePersonRow[])
    : []) as PhonePersonRow[];
  const dmRows = (dmRes.data ?? []) as DmThreadRow[];
  const groupRows = (groupRes.data ?? []) as GroupThreadPhoneRow[];
  // select_group_thread_lids returns jsonb (array) rather than SETOF so we
  // can exceed the 1000-row PostgREST cap (same trick as phone + lid maps).
  const groupLidRows = (Array.isArray(groupLidRes.data)
    ? (groupLidRes.data as GroupThreadLidRow[])
    : []) as GroupThreadLidRow[];
  // select_lid_phone_map mirrors select_phone_person_map (returns a single
  // jsonb array rather than SETOF, to bypass the 1000-row cap).
  const lidRows = (Array.isArray(lidMapRes.data)
    ? (lidMapRes.data as LidPhoneRow[])
    : []) as LidPhoneRow[];
  const emailRows = (emailRes.data ?? []) as EmailInteractionRow[];

  const runAt = new Date().toISOString();

  // ---------- Step 2: project nodes ----------
  //
  // `last_interaction_at` must reflect the actual real-world time the
  // founder last interacted with the person -- not the observation's
  // wall-clock observed_at (which is the enrichment ingest time, all
  // clumped in the last few days). Derive it from the raw edge sources:
  // DM thread last_at, SHARED_GROUP last_at, EMAILED last_at. Falls back
  // to the observation's last_seen when the person has no edges (kept as
  // a weak signal rather than leaving last_interaction_at null).

  const phoneMap = new Map<string, string>();
  for (const row of phoneRows) {
    if (!phoneMap.has(row.phone)) phoneMap.set(row.phone, row.person_id);
  }

  // LID → phone map from lid_phone_bridge. Bridge stores phones as raw
  // digits (no '+'); phoneMap keys are +E164. We canonicalize by prefixing
  // '+' on lookup. Entries in participants_raw carry `<digits>@lid` — we
  // pre-split in select_group_thread_lids so lid rows are bare digits.
  const lidToPhone = new Map<string, string>();
  for (const row of lidRows) {
    if (!row.lid || !row.phone) continue;
    const digits = String(row.phone).replace(/\D+/g, "");
    if (!digits) continue;
    lidToPhone.set(row.lid, `+${digits}`);
  }

  // Fold LID-sender group rows into the same shape as phone-sender rows
  // by resolving lid→phone via the bridge. Rows whose LID has no bridge
  // entry (unseen phone) are dropped — they'll resolve once the bridge
  // catches up. Rows whose resolved phone has no person are kept (they
  // still contribute nothing to edges, by design — same as phone rows).
  const groupRowsMerged: GroupThreadPhoneRow[] = [...groupRows];
  let lidResolved = 0;
  let lidUnresolved = 0;
  for (const g of groupLidRows) {
    const phone = lidToPhone.get(g.lid);
    if (!phone) {
      lidUnresolved += 1;
      continue;
    }
    lidResolved += 1;
    groupRowsMerged.push({
      thread_id: g.thread_id,
      phone,
      last_at: g.last_at,
      msg_count: Number(g.msg_count),
    });
  }
  console.log(
    `[graph/populate] LID bridge: rows_in=${groupLidRows.length} resolved=${lidResolved} unresolved=${lidUnresolved}`,
  );

  const personLastInteractionMap = new Map<string, string>();
  const bumpLast = (personId: string, at: string | null) => {
    if (!personId || !at) return;
    const prev = personLastInteractionMap.get(personId);
    if (!prev || at > prev) personLastInteractionMap.set(personId, at);
  };
  for (const d of dmRows) {
    const personId = phoneMap.get(d.thread_phone);
    if (personId) bumpLast(personId, d.last_at);
  }
  for (const g of groupRowsMerged) {
    const personId = phoneMap.get(g.phone);
    if (personId) bumpLast(personId, g.last_at);
  }
  for (const e of emailRows) {
    bumpLast(e.person_id, e.last_at);
  }

  const nodes: GraphNode[] = nodeRows.map((r) => ({
    id: r.id,
    user_id: userId,
    name: r.name,
    category: r.category,
    company: r.company,
    title: r.title,
    relationship_to_me: r.relationship_to_me ?? "",
    phone_count: r.phone_count ?? 0,
    email_count: r.email_count ?? 0,
    first_seen: r.first_seen,
    last_interaction_at: personLastInteractionMap.get(r.id) ?? r.last_seen,
    updated_at: runAt,
  }));

  // ---------- Step 3: project edges ----------

  // Per-user profile.self_node_id wins; env vars are fallback only.
  // This is the multi-tenant-correct path — the env vars assume one
  // founder, which breaks the moment a second one (Hardeep) shows up.
  const selfPersonId = auth.selfNodeId
    ?? findSelfPersonId(
      nodeRows,
      phoneMap,
      (process.env.ORBIT_SELF_EMAIL || "").trim() || undefined,
      (process.env.ORBIT_SELF_PHONE || "").trim() || undefined,
    );

  // DM edges: self <-> person, aggregated from thread stats.
  const dmEdges: GraphEdge[] = [];
  if (selfPersonId) {
    for (const d of dmRows) {
      const personId = phoneMap.get(d.thread_phone);
      if (!personId || personId === selfPersonId) continue;
      const messageCount = Number(d.msg_count);
      const weight = computeWeight(messageCount, d.last_at);
      dmEdges.push({
        a_id: selfPersonId,
        b_id: personId,
        user_id: userId,
        weight,
        updated_at: runAt,
        message_count: messageCount,
        first_at: d.first_at,
        last_at: d.last_at,
      });
    }
  }

  // SHARED_GROUP edges: pairwise among persons who share a group thread_id.
  // We collapse to a single edge per (a, b) across all shared groups and
  // carry group_ids as a deduped list.
  const groupByThread = new Map<
    string,
    Map<string, { last_at: string; msg_count: number }>
  >();
  for (const g of groupRowsMerged) {
    const personId = phoneMap.get(g.phone);
    if (!personId) continue;
    let perThread = groupByThread.get(g.thread_id);
    if (!perThread) {
      perThread = new Map();
      groupByThread.set(g.thread_id, perThread);
    }
    const existing = perThread.get(personId);
    if (!existing) {
      perThread.set(personId, { last_at: g.last_at, msg_count: Number(g.msg_count) });
    } else {
      if (g.last_at > existing.last_at) existing.last_at = g.last_at;
      existing.msg_count += Number(g.msg_count);
    }
  }

  // Also pull self into every group thread so we get self<->other edges
  // even when self didn't post via phone in the raw row. Self is
  // implicitly part of every group we see messages from (we ingested them).
  if (selfPersonId) {
    for (const [threadId, perThread] of groupByThread) {
      if (!perThread.has(selfPersonId)) {
        // Use the max last_at across the thread as self's last_at proxy.
        let maxLast = "";
        for (const v of perThread.values()) {
          if (v.last_at > maxLast) maxLast = v.last_at;
        }
        perThread.set(selfPersonId, { last_at: maxLast, msg_count: 1 });
      }
      void threadId;
    }
  }

  // Build pair-aggregates.
  type PairKey = string;
  const pairKey = (a: string, b: string): PairKey => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const sharedGroupPairs = new Map<
    PairKey,
    { a_id: string; b_id: string; group_ids: Set<string>; last_at: string }
  >();

  // Skip mega-groups: SHARED_GROUP edges are O(n²) per group; large
  // WhatsApp groups (>30 members) produce thousands of noisy pairs
  // that explode Neo4j + drown out meaningful direct DM/EMAIL edges.
  const SHARED_GROUP_MAX_MEMBERS = 30;
  for (const [threadId, perThread] of groupByThread) {
    const persons = Array.from(perThread.keys());
    if (persons.length < 2) continue;
    if (persons.length > SHARED_GROUP_MAX_MEMBERS) continue;
    for (let i = 0; i < persons.length; i++) {
      for (let j = i + 1; j < persons.length; j++) {
        const a = persons[i];
        const b = persons[j];
        const key = pairKey(a, b);
        let agg = sharedGroupPairs.get(key);
        if (!agg) {
          agg = {
            a_id: a < b ? a : b,
            b_id: a < b ? b : a,
            group_ids: new Set<string>(),
            last_at: "",
          };
          sharedGroupPairs.set(key, agg);
        }
        agg.group_ids.add(threadId);
        const lastThreadAt =
          perThread.get(a)!.last_at > perThread.get(b)!.last_at
            ? perThread.get(a)!.last_at
            : perThread.get(b)!.last_at;
        if (lastThreadAt > agg.last_at) agg.last_at = lastThreadAt;
      }
    }
  }

  const sharedGroupEdges: GraphEdge[] = [];
  for (const agg of sharedGroupPairs.values()) {
    const groupIds = Array.from(agg.group_ids);
    sharedGroupEdges.push({
      a_id: agg.a_id,
      b_id: agg.b_id,
      user_id: userId,
      weight: computeSharedGroupWeight(groupIds.length, agg.last_at || null),
      updated_at: runAt,
      group_ids: groupIds,
      group_count: groupIds.length,
      last_at: agg.last_at || null,
    });
  }

  // EMAILED edges: self <-> person via email-channel interaction stats.
  const emailEdges: GraphEdge[] = [];
  if (selfPersonId) {
    for (const e of emailRows) {
      if (e.person_id === selfPersonId) continue;
      const messageCount = Number(e.msg_count);
      emailEdges.push({
        a_id: selfPersonId,
        b_id: e.person_id,
        user_id: userId,
        weight: computeWeight(messageCount, e.last_at),
        updated_at: runAt,
        message_count: messageCount,
        thread_count: messageCount, // 1 observation = 1 thread in V0
        first_at: e.first_at,
        last_at: e.last_at,
      });
    }
  }

  // ---------- Step 4: write Neo4j ----------

  let nodesWritten = 0;
  let dmWritten = 0;
  let sharedGroupWritten = 0;
  let emailedWritten = 0;
  let prunedNodes = 0;
  let prunedEdges = 0;
  let scoreSummary: Awaited<ReturnType<typeof recomputeScores>> = { nodes: 0, max_score: 0, top5: [] };

  try {
    await withWriteSession(async (session) => {
      await ensureIndexes(session);
      nodesWritten = await mergeNodes(session, nodes);
      dmWritten = await mergeEdges(session, "DM", dmEdges);
      sharedGroupWritten = await mergeEdges(session, "SHARED_GROUP", sharedGroupEdges);
      emailedWritten = await mergeEdges(session, "EMAILED", emailEdges);
      // Prune AFTER successful writes -- on a failed run the graph stays
      // in prior consistent state (edges upserted above are idempotent).
      prunedEdges = await pruneStaleEdges(session, userId, runAt);
      prunedNodes = await pruneStaleNodes(session, userId, runAt);
      // Score recompute is pure-degree and has to run AFTER edges/prune.
      scoreSummary = await recomputeScores(session, userId);
    });
  } catch (err) {
    console.error("[graph/populate] neo4j write failed", err);
    return NextResponse.json(
      {
        error: {
          code: "NEO4J_UNAVAILABLE",
          message: "Could not write graph to Neo4j",
        },
      },
      { status: 503 },
    );
  }

  const breakdown: EdgeBreakdown = {
    dm: dmWritten,
    shared_group: sharedGroupWritten,
    emailed: emailedWritten,
  };
  const edgesWritten = dmWritten + sharedGroupWritten + emailedWritten;

  return NextResponse.json({
    nodes_written: nodesWritten,
    edges_written: edgesWritten,
    breakdown,
    pruned: { nodes: prunedNodes, edges: prunedEdges },
    scores: {
      nodes_scored: scoreSummary.nodes,
      max_score: scoreSummary.max_score,
      top5: scoreSummary.top5,
    },
    lid_bridge: {
      lid_rows: lidRows.length,
      group_lid_rows: groupLidRows.length,
      resolved: lidResolved,
      unresolved: lidUnresolved,
    },
    self_person_id: selfPersonId,
    elapsed_ms: Date.now() - t0,
  });
}
