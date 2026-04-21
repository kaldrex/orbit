#!/usr/bin/env node
/**
 * topic-resonance.mjs — Phase 4 / subagent C
 *
 * Batched NER over every WhatsApp message in ~/.wacli/wacli.db, grouped
 * by sender-to-person. For each person we call Haiku 4.5 with batches of
 * 30 messages and ask it to extract canonical topic phrases with rough
 * relative weights. Per-person topic lists are merged across batches,
 * capped at 20 topics, then POSTed to Orbit via the API (Bearer auth,
 * same three contracts as every other writer).
 *
 *   Read:   SQLite (wacli.db messages + session.db lid map)
 *   Classify: Anthropic Haiku 4.5 (prompt-cached system block >2048 tok)
 *   Write:  POST /api/v1/person/:id/topics
 *
 * Runs on:
 *   • Mac, dev mode:   node --env-file=.env.local scripts/topic-resonance.mjs
 *   • claw, SSH run:   node --env-file=~/.openclaw/.env topic-resonance.mjs
 *
 * Env:
 *   ANTHROPIC_API_KEY        required
 *   ORBIT_API_URL            e.g. http://100.97.152.84:3047/api/v1
 *   ORBIT_API_KEY            Bearer token for Orbit
 *   WACLI_DB_PATH (opt)      override wacli.db path
 *   SESSION_DB_PATH (opt)    override session.db path
 *   TOPIC_OUT_DIR (opt)      override output dir (default: outputs/topic-resonance-<date>)
 *   TOPIC_BUDGET_USD (opt)   default 10.0
 *   TOPIC_MAX_PERSONS (opt)  cap #persons processed (dev smoke)
 *
 * Budget ceiling: $10 (Haiku 4.5 is $1/$5 per MTok with prompt caching
 * at 0.1x read multiplier — even 33k messages fits under this).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import Anthropic from "@anthropic-ai/sdk";
import { ResilientWorker } from "./lib/resilient-worker.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ---- paths / config ---------------------------------------------------

const HOME = os.homedir();
const WACLI_DB =
  process.env.WACLI_DB_PATH ||
  (fs.existsSync(path.join(HOME, ".wacli/wacli.db"))
    ? path.join(HOME, ".wacli/wacli.db")
    : path.join(ROOT, "openclaw-snapshot/raw/wacli.db"));
const SESSION_DB =
  process.env.SESSION_DB_PATH ||
  (fs.existsSync(path.join(HOME, ".wacli/session.db"))
    ? path.join(HOME, ".wacli/session.db")
    : path.join(ROOT, "openclaw-snapshot/raw/session.db"));

const DATE_TAG = new Date().toISOString().slice(0, 10);
const OUT_DIR =
  process.env.TOPIC_OUT_DIR ||
  path.join(ROOT, "outputs", `topic-resonance-${DATE_TAG}`);

const BUDGET_USD = Number(process.env.TOPIC_BUDGET_USD ?? "10");
const MAX_PERSONS = Number(process.env.TOPIC_MAX_PERSONS ?? "0") || Infinity;

// Haiku 4.5 pricing (2026-04 list):  input $1/MTok, output $5/MTok.
// Prompt-cache write = 1.25x, cache read = 0.1x. (Same multipliers as
// Sonnet — Anthropic's uniform-across-model cache pricing.)
const PRICE_INPUT_PER_MTOK = 1.0;
const PRICE_OUTPUT_PER_MTOK = 5.0;
const PRICE_CACHE_WRITE_PER_MTOK = 1.25;
const PRICE_CACHE_READ_PER_MTOK = 0.1;

const BATCH_SIZE = 30;           // messages per LLM call
const CONCURRENCY = 4;
const MAX_MSGS_PER_PERSON = 300; // cap context per person (keeps cost sane)
const MAX_TOPICS_PER_PERSON = 20;
const MAX_TOKENS_OUT = 1800;

const ORBIT_API_URL = (process.env.ORBIT_API_URL || "").replace(/\/$/, "");
const ORBIT_API_KEY = process.env.ORBIT_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) die("ANTHROPIC_API_KEY missing");
if (!ORBIT_API_URL || !ORBIT_API_KEY) die("ORBIT_API_URL / ORBIT_API_KEY missing");

fs.mkdirSync(OUT_DIR, { recursive: true });

const t0 = Date.now();
function elapsed() { return `${((Date.now() - t0) / 1000).toFixed(1)}s`; }
function log(...a) { console.error(`[${elapsed()}]`, ...a); }
function die(m) { console.error(`FATAL: ${m}`); process.exit(1); }

// ---- Phase 1: persons + phone→LID -------------------------------------

async function fetchAllPersons() {
  const persons = [];
  let cursor = null;
  const pageSize = 1000;
  const maxPages = 10;
  let page = 0;
  while (page < maxPages) {
    const qs = new URLSearchParams({ limit: String(pageSize) });
    if (cursor) qs.set("cursor", cursor);
    const r = await fetch(`${ORBIT_API_URL}/persons/enriched?${qs}`, {
      headers: { Authorization: `Bearer ${ORBIT_API_KEY}` },
    });
    if (!r.ok) die(`persons/enriched HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const json = await r.json();
    const rows = json.persons ?? [];
    for (const row of rows) {
      if (!Array.isArray(row.phones) || row.phones.length === 0) continue;
      persons.push({ id: row.id, name: row.name ?? "(unknown)", phones: row.phones });
    }
    if (!json.next_cursor || rows.length === 0) break;
    cursor = json.next_cursor;
    page++;
  }
  return persons;
}

function loadPhoneToLid() {
  if (!fs.existsSync(SESSION_DB)) {
    log(`session.db missing at ${SESSION_DB} — LID bridging disabled`);
    return new Map();
  }
  const db = new Database(SESSION_DB, { readonly: true });
  const rows = db.prepare("SELECT lid, pn FROM whatsmeow_lid_map").all();
  db.close();
  const map = new Map(); // phoneDigits -> lid (without @lid)
  for (const r of rows) {
    const pn = String(r.pn || "").trim();
    const lid = String(r.lid || "").trim();
    if (!pn || !lid) continue;
    map.set(pn.replace(/\D+/g, ""), lid.split(":")[0]);
  }
  return map;
}

// ---- Phase 2: gather messages per person -----------------------------

function gatherMessages(persons, phoneToLid) {
  if (!fs.existsSync(WACLI_DB)) die(`wacli.db missing at ${WACLI_DB}`);
  const db = new Database(WACLI_DB, { readonly: true });

  // DM messages for <phone>@s.whatsapp.net — either direction.
  const dmStmt = db.prepare(`
    SELECT ts, from_me,
           COALESCE(NULLIF(text,''), NULLIF(display_text,''), NULLIF(media_caption,'')) AS body,
           chat_name
      FROM messages
     WHERE chat_jid = ?
       AND COALESCE(NULLIF(text,''), NULLIF(display_text,''), NULLIF(media_caption,'')) IS NOT NULL
     ORDER BY ts DESC
     LIMIT ?
  `);

  // Group messages authored by this person (any group, via their LID).
  const groupByLidStmt = db.prepare(`
    SELECT m.ts, m.chat_name,
           COALESCE(NULLIF(m.text,''), NULLIF(m.display_text,''), NULLIF(m.media_caption,'')) AS body
      FROM messages m
     WHERE m.sender_jid = ?
       AND m.chat_jid LIKE '%@g.us'
       AND COALESCE(NULLIF(m.text,''), NULLIF(m.display_text,''), NULLIF(m.media_caption,'')) IS NOT NULL
     ORDER BY m.ts DESC
     LIMIT ?
  `);

  // Group messages authored by this person (old schema, phone-jid sender).
  const groupByPhoneJidStmt = db.prepare(`
    SELECT m.ts, m.chat_name,
           COALESCE(NULLIF(m.text,''), NULLIF(m.display_text,''), NULLIF(m.media_caption,'')) AS body
      FROM messages m
     WHERE m.sender_jid = ?
       AND m.chat_jid LIKE '%@g.us'
       AND COALESCE(NULLIF(m.text,''), NULLIF(m.display_text,''), NULLIF(m.media_caption,'')) IS NOT NULL
     ORDER BY m.ts DESC
     LIMIT ?
  `);

  const out = [];
  let stats = { withMsgs: 0, empty: 0, totalMsgs: 0 };
  for (const p of persons) {
    const msgs = [];
    const seen = new Set(); // dedup by ts+body prefix
    for (const phone of p.phones) {
      const digits = String(phone).replace(/\D+/g, "");
      if (!digits) continue;
      const dmJid = `${digits}@s.whatsapp.net`;
      for (const m of dmStmt.all(dmJid, MAX_MSGS_PER_PERSON)) {
        const body = cleanBody(m.body);
        if (!body) continue;
        const key = `${m.ts}|${body.slice(0, 40)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        msgs.push({ ts: m.ts, body, ctx: "dm", from_me: m.from_me });
      }
      // Group-side via LID
      const lid = phoneToLid.get(digits);
      if (lid) {
        for (const m of groupByLidStmt.all(`${lid}@lid`, MAX_MSGS_PER_PERSON)) {
          const body = cleanBody(m.body);
          if (!body) continue;
          const key = `${m.ts}|${body.slice(0, 40)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          msgs.push({ ts: m.ts, body, ctx: `grp:${m.chat_name ?? ""}` });
        }
      }
      // Group-side with phone-jid (pre-LID era)
      for (const m of groupByPhoneJidStmt.all(dmJid, MAX_MSGS_PER_PERSON)) {
        const body = cleanBody(m.body);
        if (!body) continue;
        const key = `${m.ts}|${body.slice(0, 40)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        msgs.push({ ts: m.ts, body, ctx: `grp:${m.chat_name ?? ""}` });
      }
    }
    msgs.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const trimmed = msgs.slice(0, MAX_MSGS_PER_PERSON);
    if (trimmed.length === 0) {
      stats.empty++;
      continue;
    }
    stats.withMsgs++;
    stats.totalMsgs += trimmed.length;
    out.push({ id: p.id, name: p.name, messages: trimmed });
  }
  db.close();
  return { persons: out, stats };
}

function cleanBody(raw) {
  if (!raw) return "";
  // Strip NULs, zero-width, and excessive whitespace. Keep emojis (they
  // carry topical signal — the "🎉 Aakaar launched!" form).
  let s = String(raw).replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
  // Drop unpaired UTF-16 surrogates.
  s = s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
  if (s.length > 600) s = s.slice(0, 600) + "…";
  return s;
}

// ---- Phase 3: LLM topic extraction ------------------------------------

const SYSTEM_PROMPT = `You are a topic-extraction agent for Orbit, a founder-relationship memory system.

You will receive a JSON object containing ONE person's name plus an array of their recent WhatsApp message bodies (DM + shared-group messages they authored).

Your job: extract the set of distinct TOPICS that characterize this person's signal, and assign each a relative weight.

Rules for topic phrasing:
- Canonical, short, lowercase phrases. 1-4 words each.
- Prefer named entities (projects, companies, products, events, hackathons, cohorts, technologies, locations) over generic verbs.
- Collapse variants ("Aakaar production", "aakaar launch", "aakaar reel") into one canonical topic ("aakaar").
- Skip chit-chat ("good morning", "haha", "ok").
- Skip conversation scaffolding ("meeting", "call", "thanks").
- Skip phone numbers, emails, URLs.
- A topic is only valid if it appears across multiple messages OR is a strong named-entity signal (product name, company, event) in even one message.

Rules for weights:
- Weights are relative, 0..1. Normalize so the heaviest topic on this person is ~1.0.
- Lighter topics scale linearly with observed frequency / salience.
- Do NOT pad. If the person has 50 messages all about one thing, return that one topic at weight 1.0 and nothing else.
- Minimum weight threshold: 0.15. Never emit a topic below that.

Rules for count:
- Emit AT MOST 10 topics. Better 5 strong topics than 10 mediocre ones.
- If the messages are entirely junk (forwards, spam, one-liners), emit [].

Output shape:
{"topics": [{"topic": "<lowercase-phrase>", "weight": <0.15..1.0>}]}

Output MUST be valid JSON, nothing else. No prose, no markdown fences, no commentary.

========================================================================
FEW-SHOT EXAMPLES

INPUT 1:
{"name": "Meet", "messages": [
  {"body": "Aakaar reel is live bro! check it on insta", "ctx": "dm"},
  {"body": "mumbai trade fair is sponsoring us for Aakaar", "ctx": "dm"},
  {"body": "got 3 more sponsors for aakaar this week", "ctx": "dm"},
  {"body": "can you help edit the reels", "ctx": "dm"},
  {"body": "budget for aakaar is 8L total", "ctx": "dm"}
]}

OUTPUT 1:
{"topics":[{"topic":"aakaar","weight":1.0},{"topic":"sponsors","weight":0.6},{"topic":"reels","weight":0.4}]}

INPUT 2:
{"name": "Umayr", "messages": [
  {"body": "shipped the sinx agent v2 today", "ctx": "dm"},
  {"body": "dubai llm meetup was sick", "ctx": "dm"},
  {"body": "anthropic just dropped opus 4.7", "ctx": "grp:AI Tinkerers"},
  {"body": "sinx is hiring for an ml infra role", "ctx": "dm"},
  {"body": "dubai startup scene is actually popping off", "ctx": "dm"}
]}

OUTPUT 2:
{"topics":[{"topic":"sinx","weight":1.0},{"topic":"dubai","weight":0.7},{"topic":"ai agents","weight":0.5},{"topic":"anthropic","weight":0.3}]}

INPUT 3 (junk — no signal):
{"name": "Random saved contact", "messages": [
  {"body": "hello", "ctx": "dm"},
  {"body": "good morning", "ctx": "dm"}
]}

OUTPUT 3:
{"topics":[]}

========================================================================
NOTE: repetition is the signal. "Aakaar" mentioned 8 times across 30 messages is a stronger topic than "budget" mentioned once. Your weights should roughly reflect that mental counting.

Also: named projects, companies, hackathons, products, places of residence, and cohorts are always topics. Scheduling chit-chat is never a topic.

Pad: the system block below is intentionally verbose so that repeated
calls to this endpoint hit the prompt cache (ephemeral), cutting input
cost 10x on every call after the first. The extra text is not content —
it is deliberate padding so the system block exceeds Anthropic's 2,048
token cache-threshold. The rest of this block is a longer description
of topic-extraction best practices to pad the cache key.

When deciding whether something is a topic:
- Does it name a project? It's a topic.
- Does it name a company? It's a topic.
- Does it name a city, country, or region? Only if repeated or tied to
  identity signal (e.g. "I'm based in Dubai"). One-off locations in
  travel chat are not topics.
- Does it name a technology? Yes, but aggregate to canonical form:
  "langchain" not "langchain v0.3.1". "nextjs" not "next.js 16".
- Does it name an event, cohort, or community? Yes: "buildspace s5",
  "antler 24", "deep blue cohort", "ns nights mumbai".
- Is it an emotion or reaction? Never a topic.
- Is it a greeting or acknowledgment? Never a topic.
- Is it a URL, phone, or email? Never a topic.

When deciding canonical form:
- Lowercase the final phrase.
- Strip articles ("the", "a").
- Strip trailing words like "launch", "update", "demo" unless they
  are part of the canonical name (e.g. "wwdc demo" if the event is
  "wwdc demo" literally — otherwise drop "demo").
- Prefer the project / company / event name alone.
- One or two words is ideal; three is the sensible cap; four is the
  hard cap.

When deciding weights:
- Count rough mentions or strong-signal hits.
- Normalize so the heaviest is near 1.0.
- Anything below 0.15 drops.
- Do not try to be precise — relative is what matters.

When the data is thin:
- 3 messages about "aakaar" with nothing else → [{"topic":"aakaar","weight":1.0}].
- All greetings → [].
- Mix of one project and daily chit-chat → just the project, weight 1.0.

When the data is rich (50+ messages):
- Expect 5-10 topics.
- The heaviest should be clearly dominant.
- A long tail of weight 0.2 topics is fine if they are all real.

========================================================================
PROMPT-CACHE PADDING — the section below is intentional boilerplate so
the system block crosses Anthropic's 2,048-token cache threshold. Read
it, internalize the principles, but know it is deliberately verbose.

Why topic resonance matters in Orbit
------------------------------------
Orbit's thesis is that a founder's long tail of contacts — the 1,500+
humans they have touched at least once across WhatsApp, Gmail, and
other channels — is more valuable than the top 30 they already
remember. The product must therefore answer questions like:
  - "Who among my contacts is currently shipping an AI product?"
  - "Who's been talking about Dubai or the Middle East startup scene?"
  - "Who are my founders-of-legal-tech-products cohort?"
These questions reduce to topic-overlap queries. Without topics, the
cards are just names + categories. With topics, the cards become a
searchable, filterable, associative memory.

Why we use Haiku 4.5 for this task
----------------------------------
Haiku 4.5 is fast (<1s per call), cheap ($1/MTok input, $5/MTok output
with a 10x cache-read discount), and sufficient for NER + canonical
phrasing. We don't need Opus's multi-hop reasoning — we need a
high-throughput pattern recognizer. One call per person per 30
messages, a few thousand calls total, at a few dollars total spend.

Canonical phrasing is a discipline
----------------------------------
A common mistake is to emit topics like "aakaar production update" or
"the aakaar launch event 2026" or "aakaar reels v2". These are all the
same underlying concept. Collapse them. The canonical topic is
"aakaar" — the bare project / entity name. Versioning, stage, and
adjective suffixes all drop.

Another common mistake is to emit phrases that include the person's
verb ("shipping aakaar", "planning aakaar") instead of the noun alone.
Drop the verb. We want the noun.

Another common mistake is to emit near-duplicates ("fundraising" and
"fundraise" and "raising money"). Pick one canonical form — "fund-
raising" — and collapse the rest.

Locations and regions
---------------------
If a person repeatedly mentions a city in an identity-signal way
("I'm in Dubai", "back in Mumbai this week", "meeting at Bandra
tomorrow"), that city IS a topic. If they mention a city once in
transit chat ("heard you're in SF"), that city is NOT a topic.

Technologies and tools
----------------------
Technologies are topics when the person mentions them in a
working-on-it or decision-making context. "using next.js for the
landing page" — topic. "just heard about next.js 16" — not a topic.

People and brand names
----------------------
People names (other humans) are topics only if they appear as a
recurring subject of conversation. Random greetings (\"hi Priya\")
are not.

Junk filtering
--------------
If the messages are forwards, status updates, or pure scheduling
chat, the correct output is an empty list. Do not fabricate topics.
Empty output is valid and often the honest answer.

Output envelope
---------------
Always the exact shape:
  {"topics": [{"topic": "string", "weight": 0.15..1.0}]}
No commentary. No code fences. No trailing text. If you are unsure
about the JSON shape, re-read the FEW-SHOT EXAMPLES block above.

Output ONLY the JSON object. No fences, no preamble, no trailing text.`;

function callHaiku(client, personName, messages) {
  const trimmedMsgs = messages.slice(0, BATCH_SIZE).map((m) => ({
    body: m.body,
    ctx: m.ctx,
  }));
  const userInput = { name: personName, messages: trimmedMsgs };

  return client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: MAX_TOKENS_OUT,
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      { role: "user", content: `Extract topics for this person.\n\nINPUT:\n${JSON.stringify(userInput)}` },
    ],
  });
}

function parseTopicsFromResponse(resp) {
  let raw = "";
  for (const block of resp.content) if (block.type === "text") raw += block.text;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1];
  raw = raw.trim();
  const parsed = JSON.parse(raw);
  const arr = Array.isArray(parsed?.topics) ? parsed.topics : [];
  const cleaned = [];
  for (const t of arr) {
    if (!t || typeof t !== "object") continue;
    const topic = String(t.topic ?? "").trim().toLowerCase();
    const weight = Number(t.weight);
    if (!topic || topic.length > 80) continue;
    if (!Number.isFinite(weight) || weight < 0.15 || weight > 1) continue;
    cleaned.push({ topic, weight });
  }
  return cleaned;
}

function batchCost(usage) {
  const ia = (usage?.input_tokens ?? 0) * PRICE_INPUT_PER_MTOK;
  const oa = (usage?.output_tokens ?? 0) * PRICE_OUTPUT_PER_MTOK;
  const cw = (usage?.cache_creation_input_tokens ?? 0) * PRICE_CACHE_WRITE_PER_MTOK;
  const cr = (usage?.cache_read_input_tokens ?? 0) * PRICE_CACHE_READ_PER_MTOK;
  return (ia + oa + cw + cr) / 1e6;
}

// Merge the topic lists produced by N sub-batches for one person.
function mergeTopicLists(lists) {
  const map = new Map();
  let heaviestAcrossAllSubBatches = 0;
  for (const list of lists) {
    for (const t of list) {
      heaviestAcrossAllSubBatches = Math.max(heaviestAcrossAllSubBatches, t.weight);
      // Use sum-with-decay: a topic that shows up in every sub-batch
      // accumulates weight, but we halve duplicates so a topic that
      // appears N times doesn't end up with weight N.
      const cur = map.get(t.topic) ?? 0;
      map.set(t.topic, cur + t.weight * (cur === 0 ? 1 : 0.5));
    }
  }
  // Normalize so heaviest merged weight == 1.0.
  const merged = Array.from(map, ([topic, weight]) => ({ topic, weight }));
  merged.sort((a, b) => b.weight - a.weight);
  const top = merged[0]?.weight ?? 1;
  for (const m of merged) m.weight = top > 0 ? m.weight / top : 0;
  // Cap + threshold.
  return merged
    .filter((m) => m.weight >= 0.15)
    .slice(0, MAX_TOPICS_PER_PERSON);
}

// ---- Phase 4: POST to Orbit ------------------------------------------

async function postTopics(personId, topics) {
  const r = await fetch(`${ORBIT_API_URL}/person/${personId}/topics`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ORBIT_API_KEY}`,
    },
    body: JSON.stringify({ topics }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`POST ${personId} HTTP ${r.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// ---- Main --------------------------------------------------------------

async function main() {
  log(`starting — wacli=${WACLI_DB} session=${SESSION_DB}`);
  log(`budget=$${BUDGET_USD}, maxPersons=${MAX_PERSONS === Infinity ? "∞" : MAX_PERSONS}`);

  const personsAll = await fetchAllPersons();
  log(`phase 1: fetched ${personsAll.length} persons with phones`);
  const lidMap = loadPhoneToLid();
  log(`phase 1: loaded ${lidMap.size} phone→LID entries`);

  const persons = personsAll.slice(0, Number.isFinite(MAX_PERSONS) ? MAX_PERSONS : personsAll.length);

  const { persons: withMsgs, stats } = gatherMessages(persons, lidMap);
  log(`phase 2: persons with messages=${stats.withMsgs}, empty=${stats.empty}, total msgs=${stats.totalMsgs}`);

  fs.writeFileSync(
    path.join(OUT_DIR, "persons-with-messages.ndjson"),
    withMsgs.map((p) => JSON.stringify({ id: p.id, name: p.name, msg_count: p.messages.length })).join("\n") + "\n",
  );

  if (withMsgs.length === 0) {
    log("no persons with messages — nothing to do");
    return;
  }

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  // Build "mega-targets": one per (person, sub-batch) so resilient-worker
  // can retry a single sub-batch without losing progress on other
  // sub-batches of the same person. Topic merging happens at the end.
  const subTargets = [];
  for (const p of withMsgs) {
    const chunks = chunk(p.messages, BATCH_SIZE);
    for (let ci = 0; ci < chunks.length; ci++) {
      subTargets.push({
        person_id: p.id,
        person_name: p.name,
        chunk_index: ci,
        total_chunks: chunks.length,
        messages: chunks[ci],
      });
    }
  }
  log(`phase 3: ${withMsgs.length} persons × avg ${(subTargets.length / withMsgs.length).toFixed(1)} sub-batches = ${subTargets.length} LLM calls`);

  // Collect sub-batch outputs per person.
  const perPerson = new Map();
  for (const p of withMsgs) perPerson.set(p.id, { person: p, lists: [] });
  let totalCost = 0;
  const tokenTotals = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

  // Warm the cache: one serial call before launching parallel workers so
  // the prompt-cache entry is established.
  if (subTargets.length > 0) {
    const first = subTargets[0];
    try {
      const resp = await callHaiku(anthropic, first.person_name, first.messages);
      const topics = parseTopicsFromResponse(resp);
      perPerson.get(first.person_id)?.lists.push(topics);
      totalCost += batchCost(resp.usage);
      accumulateUsage(tokenTotals, resp.usage);
      log(`warm: person=${first.person_name} topics=${topics.length} cost=$${totalCost.toFixed(4)} cache_w=${resp.usage?.cache_creation_input_tokens ?? 0}`);
      subTargets.shift();
    } catch (err) {
      log(`warm batch FAILED: ${err.message}`);
    }
  }

  const worker = new ResilientWorker({
    runId: `topic-resonance-${DATE_TAG}`,
    outDir: OUT_DIR,
    targets: subTargets,
    batchSize: 1,       // one sub-target per batch (we already sliced)
    concurrency: CONCURRENCY,
    retry: { maxAttempts: 3, backoffMs: [3000, 10000, 30000] },
    budget: { maxCostUSD: BUDGET_USD, maxWallMin: 120 },
    classifyError: (err) => {
      const s = err?.status ?? err?.statusCode ?? 0;
      if (s === 400 || err?.name === "SyntaxError") return "PERMANENT";
      return "TRANSIENT";
    },
    processBatch: async (items) => {
      // batchSize is 1, so items is a 1-element list.
      const item = items[0];
      const resp = await callHaiku(anthropic, item.person_name, item.messages);
      const usage = resp.usage ?? {};
      const topics = parseTopicsFromResponse(resp);
      return { ok: true, outputs: [{ item, topics, usage }] };
    },
    emitBatch: async (outputs) => {
      for (const o of outputs) {
        perPerson.get(o.item.person_id)?.lists.push(o.topics);
        totalCost += batchCost(o.usage);
        accumulateUsage(tokenTotals, o.usage);
      }
    },
  });

  const result = await worker.run();
  log(`phase 3 done: ${result.completedBatches} batches, cost≈$${totalCost.toFixed(3)}, quarantined=${result.quarantined}`);

  // Merge per-person topic lists.
  const finalTopics = [];
  for (const [personId, { person, lists }] of perPerson) {
    if (lists.length === 0) continue;
    const merged = mergeTopicLists(lists);
    if (merged.length === 0) continue;
    finalTopics.push({ person_id: personId, name: person.name, topics: merged });
  }

  fs.writeFileSync(
    path.join(OUT_DIR, "final-topics.ndjson"),
    finalTopics.map((t) => JSON.stringify(t)).join("\n") + "\n",
  );
  log(`merged: ${finalTopics.length} persons with ≥1 topic`);

  // POST to Orbit.
  let posted = 0, failed = 0;
  for (const f of finalTopics) {
    try {
      await postTopics(f.person_id, f.topics);
      posted++;
    } catch (err) {
      failed++;
      log(`POST ${f.person_id} (${f.name}) FAILED: ${err.message}`);
    }
  }
  log(`phase 4: posted=${posted}, failed=${failed}`);

  // Summary.
  const topicFreq = new Map();
  for (const f of finalTopics) for (const t of f.topics) {
    topicFreq.set(t.topic, (topicFreq.get(t.topic) ?? 0) + 1);
  }
  const topTopics = [...topicFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([topic, n]) => ({ topic, persons: n }));

  const distribution = distributionBins(finalTopics.map((f) => f.topics.length));

  const summary = {
    date: DATE_TAG,
    wall_sec: Math.round((Date.now() - t0) / 1000),
    persons_scanned: persons.length,
    persons_with_messages: withMsgs.length,
    persons_with_topics: finalTopics.length,
    persons_posted_ok: posted,
    persons_post_failed: failed,
    llm: {
      sub_batches: subTargets.length + 1, // +1 for warm
      cost_usd: Number(totalCost.toFixed(4)),
      tokens: tokenTotals,
    },
    top_topics: topTopics,
    topic_count_distribution: distribution,
  };
  fs.writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 2));
  log(`summary: ${JSON.stringify(summary.llm)} posted=${posted} top5=${topTopics.slice(0, 5).map((t) => `${t.topic}(${t.persons})`).join(",")}`);
}

function accumulateUsage(tot, usage) {
  tot.input_tokens += usage?.input_tokens ?? 0;
  tot.output_tokens += usage?.output_tokens ?? 0;
  tot.cache_creation_input_tokens += usage?.cache_creation_input_tokens ?? 0;
  tot.cache_read_input_tokens += usage?.cache_read_input_tokens ?? 0;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function distributionBins(counts) {
  const bins = { "0": 0, "1-3": 0, "4-6": 0, "7-10": 0, "11-15": 0, "16+": 0 };
  for (const c of counts) {
    if (c === 0) bins["0"]++;
    else if (c <= 3) bins["1-3"]++;
    else if (c <= 6) bins["4-6"]++;
    else if (c <= 10) bins["7-10"]++;
    else if (c <= 15) bins["11-15"]++;
    else bins["16+"]++;
  }
  return bins;
}

main().catch((err) => {
  console.error(`FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
