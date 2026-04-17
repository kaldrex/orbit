#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { OrbitClient } from "../packages/orbit-plugin/lib/orbit-client.js";
import { IdentityResolver } from "../packages/orbit-plugin/lib/identity-resolver.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  }).trim();
}

function remotePy(code) {
  return run("ssh", ["-o", "BatchMode=yes", "claw", "python3", "-"], { input: code });
}

function remoteJson(code) {
  return JSON.parse(remotePy(code));
}

async function getOrbitAuth() {
  const env = remoteJson(`
import json
from pathlib import Path
env = {}
p = Path.home()/".openclaw"/".env"
if p.exists():
    for line in p.read_text().splitlines():
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        k,v = line.split("=",1)
        env[k.strip()] = v.strip()
print(json.dumps({
  "ORBIT_API_KEY": env.get("ORBIT_API_KEY", ""),
  "ORBIT_API_URL": env.get("ORBIT_API_URL", "https://orbit-mu-roan.vercel.app/api/v1")
}))
  `);
  if (!env.ORBIT_API_KEY) {
    throw new Error("ORBIT_API_KEY missing on claw host");
  }
  return env;
}

async function fetchAllPersons(client) {
  const all = [];
  let cursor = null;
  while (true) {
    const res = await client.get("/persons", {
      limit: 500,
      order: "id",
      include_self: "true",
      cursor: cursor || undefined,
    });
    const rows = Array.isArray(res.persons) ? res.persons : [];
    if (!rows.length) break;
    all.push(...rows);
    cursor = res.nextCursor;
    if (!cursor || all.length > 5000) break;
  }
  return all;
}

function safeText(value, max = 140) {
  if (value == null) return "";
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreReconnectCandidate(person, card) {
  let score = 0;
  if (typeof person.score === "number") score += person.score * 2;
  if (person.category && person.category !== "other") score += 8;
  if (person.company) score += 4;
  if (person.email) score += 4;
  if (Array.isArray(card?.interactions) && card.interactions.length > 0) score += 6;
  if (Array.isArray(card?.sharedConnections) && card.sharedConnections.length > 0) score += 3;
  return score;
}

function buildToolCatalog() {
  return [
    {
      name: "orbit_graph_stats",
      status: "existing",
      surface: "plugin tool",
      purpose: "High-level graph totals to anchor the agent's search strategy.",
    },
    {
      name: "orbit_going_cold",
      status: "existing",
      surface: "plugin tool",
      purpose: "Fast reconnect candidate list when freshness is trustworthy.",
    },
    {
      name: "orbit_lookup",
      status: "existing",
      surface: "plugin tool",
      purpose: "Lookup by name/company after the agent has a likely target.",
    },
    {
      name: "orbit_person_card",
      status: "existing",
      surface: "plugin tool",
      purpose: "Pull interactions and shared connections for a specific person.",
    },
    {
      name: "orbit_network_search",
      status: "existing but currently broken in prod",
      surface: "plugin tool",
      purpose: "Find intro paths and company adjacency when working properly.",
    },
    {
      name: "orbit_people_list",
      status: "api exists, plugin tool missing",
      surface: "/api/v1/persons",
      purpose: "Page/filter canonical people directly. Needed for agentic exploration.",
    },
    {
      name: "orbit_identity_snapshot",
      status: "api/script exists, plugin tool partial",
      surface: "resolver dry-run",
      purpose: "Let the agent inspect duplicate/ambiguous clusters before deciding.",
    },
    {
      name: "openclaw_whatsapp_sample",
      status: "mock only",
      surface: "host local state",
      purpose: "Give the agent some raw source evidence instead of only canonical graph outputs.",
    },
  ];
}

function buildMissingTools() {
  return [
    {
      name: "orbit_recent_source_events",
      why: "The agent needs raw event evidence per person, not only canonical interaction summaries.",
    },
    {
      name: "orbit_identity_cluster",
      why: "The agent needs a direct tool to inspect merge candidates/evidence for one person.",
    },
    {
      name: "orbit_company_card",
      why: "The agent needs a company-centric surface for 'who do I know at X' workflows.",
    },
    {
      name: "orbit_review_writeback",
      why: "The agent needs a safe place to store structured judgments or review flags without mutating canonical truth immediately.",
    },
    {
      name: "orbit_event_context_packet",
      why: "Meeting prep and follow-up flows need event-specific packets assembled from all sources.",
    },
  ];
}

async function main() {
  const auth = await getOrbitAuth();
  const client = new OrbitClient(auth.ORBIT_API_KEY, auth.ORBIT_API_URL);
  const resolver = new IdentityResolver({
    client,
    logger: { info() {}, warn() {}, error() {} },
  });

  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[:.]/g, "-");
  const outDir = path.join(repoRoot, "outputs", `agentic-mock-${stamp}`);
  await fs.mkdir(outDir, { recursive: true });

  const hostState = remoteJson(`
import json
from pathlib import Path
home = Path.home()
storages = home/"gowa"/"storages"
recent = sorted(storages.glob("*RECENT.json"), key=lambda p: p.stat().st_mtime, reverse=True)
print(json.dumps({
  "openclaw_config_present": (home/".openclaw"/"openclaw.json").exists(),
  "orbit_plugin_present": (home/".openclaw"/"plugins"/"orbit-connector").exists(),
  "orbit_saas_present": (home/".openclaw"/"plugins"/"orbit-saas").exists(),
  "wacli_db_present": (home/".wacli"/"wacli.db").exists(),
  "latest_whatsapp_file": recent[0].name if recent else ""
}))
  `);

  const whatsappRows = remoteJson(`
import json
from pathlib import Path

def pick_text(msg):
    candidates = [msg.get("text"), msg.get("body"), msg.get("message"), msg.get("caption")]
    nested = msg.get("content")
    if isinstance(nested, dict):
        candidates.extend([nested.get("text"), nested.get("body"), nested.get("caption")])
    for value in candidates:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""

home = Path.home()
storages = home/"gowa"/"storages"
recent = sorted(storages.glob("*RECENT.json"), key=lambda p: p.stat().st_mtime, reverse=True)
path = recent[0] if recent else None
rows = []
if path:
    data = json.loads(path.read_text())
    for conv in data.get("conversations", []):
        conv_id = conv.get("id") or conv.get("jid") or conv.get("chatId") or ""
        conv_name = conv.get("name") or conv.get("pushName") or conv.get("displayName") or ""
        for msg in (conv.get("messages") or []):
            rows.append({
                "conversation_id": conv_id,
                "conversation_name": conv_name,
                "sender": msg.get("sender") or msg.get("participant") or msg.get("from") or "",
                "from_me": bool(msg.get("fromMe")),
                "timestamp": msg.get("timestamp") or msg.get("messageTimestamp") or msg.get("time") or "",
                "message_type": msg.get("type") or msg.get("messageType") or "",
                "text": pick_text(msg),
            })
            if len(rows) >= 80:
                break
        if len(rows) >= 80:
            break
print(json.dumps(rows))
  `);

  const graph = await client.get("/graph");
  const briefs = await client.get("/briefs", { limit: 10, days: 14 });
  const persons = (await fetchAllPersons(client)).filter((p) => p.category !== "self");
  const stageA = await resolver.runStageA({ dryRun: true, maxMerges: 20 });

  const topPeople = [...persons]
    .filter((p) => typeof p.score === "number" && p.score >= 1)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 20);

  const cards = [];
  for (const person of topPeople.slice(0, 6)) {
    try {
      const card = await client.get(`/persons/${person.id}`);
      cards.push({ person, card });
    } catch (err) {
      cards.push({ person, card: null, error: err.message });
    }
  }

  const toolTrace = [];
  toolTrace.push({
    step: 1,
    tool: "orbit_graph_stats",
    args: {},
    summary: graph,
  });

  toolTrace.push({
    step: 2,
    tool: "orbit_people_list (mock over /api/v1/persons)",
    args: { order: "score", limit: 20 },
    summary: {
      returned: topPeople.length,
      topPeople: topPeople.slice(0, 8).map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        score: p.score,
        company: p.company || null,
      })),
    },
  });

  toolTrace.push({
    step: 3,
    tool: "orbit_identity_snapshot",
    args: { stage: "A", dry_run: true, max_clusters: 20 },
    summary: {
      personsScanned: stageA.personsScanned,
      certainCount: stageA.certainCount,
      ambiguousCount: stageA.ambiguousCount,
      ambiguousPreview: stageA.ambiguousPreview.slice(0, 5),
    },
  });

  toolTrace.push({
    step: 4,
    tool: "openclaw_whatsapp_sample (mock)",
    args: { latest: true, limit: 80 },
    summary: {
      file: hostState.latest_whatsapp_file,
      rows: whatsappRows.length,
      examples: whatsappRows.slice(0, 5).map((r) => ({
        conversation_name: r.conversation_name,
        sender: r.sender,
        text: safeText(r.text, 90),
      })),
    },
  });

  const enrichedCards = cards.map(({ person, card, error }) => {
    const tokens = new Set(
      normalizeName(person.name)
        .split(" ")
        .filter((x) => x.length >= 3)
    );
    const matchingWhatsApp = whatsappRows
      .filter((row) => {
        const hay = `${row.conversation_name} ${row.sender} ${row.text}`.toLowerCase();
        return [...tokens].some((token) => hay.includes(token));
      })
      .slice(0, 3)
      .map((row) => ({
        conversation_name: row.conversation_name,
        sender: row.sender,
        text: safeText(row.text, 80),
      }));
    return {
      person,
      card,
      error,
      matchingWhatsApp,
      heuristicScore: scoreReconnectCandidate(person, card),
    };
  });

  enrichedCards.sort((a, b) => b.heuristicScore - a.heuristicScore);
  const recommended = enrichedCards[0] || null;

  toolTrace.push({
    step: 5,
    tool: "orbit_person_card",
    args: { ids: enrichedCards.map((x) => x.person.id) },
    summary: enrichedCards.map((entry) => ({
      id: entry.person.id,
      name: entry.person.name,
      category: entry.person.category,
      score: entry.person.score,
      interactionCount: Array.isArray(entry.card?.interactions) ? entry.card.interactions.length : 0,
      sharedConnections: Array.isArray(entry.card?.sharedConnections) ? entry.card.sharedConnections.length : 0,
      whatsappMatches: entry.matchingWhatsApp.length,
      heuristicScore: entry.heuristicScore,
    })),
  });

  const reconnectScenario = {
    scenario: "reconnect_this_week",
    resultType: "mock agent decision",
    judgmentMode: "heuristic placeholder until a clean programmable LLM loop is wired",
    recommendedContact: recommended
      ? {
          personId: recommended.person.id,
          name: recommended.person.name,
          category: recommended.person.category,
          company: recommended.person.company || null,
          score: recommended.person.score,
          rationale: [
            recommended.person.category && recommended.person.category !== "other"
              ? `Has a non-generic category: ${recommended.person.category}`
              : "Category is weak",
            Array.isArray(recommended.card?.interactions) && recommended.card.interactions.length
              ? `Has ${recommended.card.interactions.length} recent Orbit interactions on the card`
              : "No useful card interactions surfaced",
            recommended.matchingWhatsApp.length
              ? `Has ${recommended.matchingWhatsApp.length} raw WhatsApp matches in the sample`
              : "No raw WhatsApp match in the current sample",
          ],
        }
      : null,
    limitations: [
      "Current mock uses heuristic judgment, not an autonomous tool-calling LLM turn.",
      "Freshness is not reliable because current Orbit last_interaction_at handling is inconsistent.",
      "The agent still lacks a direct raw-event-per-person tool and an identity-cluster inspection tool.",
    ],
  };

  const findings = {
    generatedAt,
    hostState,
    currentToolCatalog: buildToolCatalog(),
    missingTools: buildMissingTools(),
    graphSnapshot: graph,
    goingColdSnapshot: briefs,
    reconnectScenario,
    toolTrace,
  };

  const markdown = [
    "# Mock Agentic Context Experiment",
    "",
    `Generated: ${generatedAt}`,
    "",
    "## What this is",
    "",
    "A deterministic mock of the agent loop we want: gather Orbit/OpenClaw context, inspect duplicates, inspect raw source evidence, then make a relationship recommendation and call out the missing tools.",
    "",
    "## Key result",
    "",
    recommended
      ? `Recommended reconnect candidate: **${recommended.person.name}** (${recommended.person.category || "other"})`
      : "No reconnect candidate selected.",
    "",
    "## Why this matters",
    "",
    "- The useful agent is not one giant prompt. It is a loop over tools and evidence packets.",
    "- The current plugin surface is good for read summaries, but weak for raw evidence and identity-review flows.",
    "- The next plugin/API additions should focus on raw-event context, identity cluster inspection, and company/event packets.",
    "",
    "## Missing tools surfaced by the mock",
    "",
    ...buildMissingTools().map((tool) => `- \`${tool.name}\`: ${tool.why}`),
    "",
    "## Files",
    "",
    "- `experiment.json` — full structured output",
    "- `experiment.md` — human-readable summary",
  ].join("\n");

  await fs.writeFile(path.join(outDir, "experiment.json"), JSON.stringify(findings, null, 2));
  await fs.writeFile(path.join(outDir, "experiment.md"), markdown);

  console.log(JSON.stringify({
    outDir,
    reconnectCandidate: reconnectScenario.recommendedContact?.name || null,
    missingTools: buildMissingTools().map((x) => x.name),
  }, null, 2));
}

await main();
