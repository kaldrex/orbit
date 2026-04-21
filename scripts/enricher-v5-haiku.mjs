#!/usr/bin/env node
/**
 * Enricher V5 — Haiku port of enricher-v4, wrapped in ResilientWorker.
 *
 * Phase 5 (Living Orbit) uses this as the enricher SKILL the claw job
 * runner shells out to on a 14-day cadence. Changes vs v4:
 *
 *   1. Model: claude-haiku-4-5-20251001 (fallback: claude-haiku-4-5 on
 *      unknown-model 400).
 *   2. Batch loop is a ResilientWorker — atomic progress.json, retry
 *      backoff, quarantine, circuit breaker, budget ceiling.
 *   3. Idempotent per person — server-side dedup_key means rerunning with
 *      the same evidence_pointer overwrites the person obs.
 *   4. System prompt padded > 2,048 tokens with the three v4 few-shots so
 *      cache_control "ephemeral" fires after the first batch.
 *
 * Budget: $8 hard ceiling, 25 min wall. Expected Haiku spend < $2.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import Database from "better-sqlite3";
import Anthropic from "@anthropic-ai/sdk";

import { ResilientWorker } from "./lib/resilient-worker.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATE_TAG = new Date().toISOString().slice(0, 10);
const OUT_DIR = path.join(ROOT, "outputs", `enricher-v5-${DATE_TAG}`);
const SNAPSHOT = path.join(ROOT, "openclaw-snapshot", "raw");
const WACLI_DB = path.join(SNAPSHOT, "wacli.db");
const SESSION_DB = path.join(SNAPSHOT, "session.db");
const GMAIL_NDJSON = path.join(SNAPSHOT, "gmail-wide-20260418.messages.ndjson");

const USER_ID = "dbb398c2-1eff-4eee-ae10-bad13be5fda7";
const SKIP_PERSON_IDS = new Set([
  "67050b91-5011-4ba6-b230-9a387879717a", // Umayr — canary
  "9e7c0448-dd3b-437c-9cda-c512dbc5764b", // Ramon
]);

// Haiku 4.5 pricing: $1 in / $5 out per MTok, cache write 1.25x, cache read 0.1x.
const PRICE_INPUT = 1.0;
const PRICE_OUTPUT = 5.0;
const PRICE_CACHE_WRITE = 1.0 * 1.25;
const PRICE_CACHE_READ = 1.0 * 0.1;

const BATCH_SIZE = 30;
const CONCURRENCY = 5;
const MAX_TOKENS_OUT = 8000;
const BUDGET_USD = 8.0;
const WALL_MIN = 25;
const PRIMARY_MODEL = "claude-haiku-4-5-20251001";
const FALLBACK_MODEL = "claude-haiku-4-5";

async function loadTargetPersons() {
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) throw new Error("SUPABASE_DB_URL not set");
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const r = await client.query(
      `
      WITH latest_person_obs AS (
        SELECT DISTINCT ON (link.person_id)
          link.person_id, o.payload
        FROM observations o
        JOIN person_observation_links link ON link.observation_id = o.id
        WHERE o.user_id = $1 AND o.kind = 'person'
        ORDER BY link.person_id, o.observed_at DESC
      )
      SELECT
        p.id::text                                AS person_id,
        COALESCE(lpo.payload->>'name', 'Unknown') AS name,
        lpo.payload->'phones'                     AS phones,
        lpo.payload->'emails'                     AS emails
      FROM persons p
      LEFT JOIN latest_person_obs lpo ON lpo.person_id = p.id
      WHERE p.user_id = $1
        AND COALESCE(lpo.payload->>'category', 'other') = 'other'
      ORDER BY p.id
      `,
      [USER_ID],
    );
    return r.rows
      .filter((row) => !SKIP_PERSON_IDS.has(row.person_id))
      .map((row) => ({
        person_id: row.person_id,
        name: row.name,
        phones: Array.isArray(row.phones) ? row.phones : [],
        emails: Array.isArray(row.emails) ? row.emails : [],
      }));
  } finally {
    await client.end();
  }
}

function loadPhoneToLidMap() {
  if (!fs.existsSync(SESSION_DB)) return { byPn: new Map() };
  const db = new Database(SESSION_DB, { readonly: true });
  try {
    const rows = db.prepare("SELECT lid, pn FROM whatsmeow_lid_map").all();
    const byPn = new Map();
    for (const r of rows) {
      const pn = String(r.pn).replace(/\D+/g, "");
      const lid = String(r.lid).split(":")[0];
      if (pn && lid) byPn.set(pn, lid);
    }
    return { byPn };
  } finally {
    db.close();
  }
}

function loadGmailIndex() {
  const byEmail = new Map();
  if (!fs.existsSync(GMAIL_NDJSON)) return byEmail;
  const data = fs.readFileSync(GMAIL_NDJSON, "utf-8");
  for (const line of data.split("\n")) {
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    const headers = m?.payload?.headers ?? [];
    let from = "", to = "", subject = "", date = "";
    for (const h of headers) {
      if (h.name === "From") from = h.value;
      else if (h.name === "To") to = h.value;
      else if (h.name === "Subject") subject = h.value;
      else if (h.name === "Date") date = h.value;
    }
    const entry = { from, to, subject, date, snippet: m?.snippet ?? "" };
    const re = /([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})/g;
    const seen = new Set();
    for (const field of [from, to]) {
      if (!field) continue;
      let mm;
      while ((mm = re.exec(field)) !== null) {
        const e = mm[1].toLowerCase();
        if (seen.has(e)) continue;
        seen.add(e);
        if (!byEmail.has(e)) byEmail.set(e, []);
        const arr = byEmail.get(e);
        if (arr.length < 30) arr.push(entry);
      }
    }
  }
  return byEmail;
}

function gatherContext(persons, gmailIndex, phoneToLid) {
  if (!fs.existsSync(WACLI_DB)) {
    return persons.map((p) => ({
      ...p,
      wa_messages: [], wa_groups: [], wa_group_messages: [],
      wa_contact_meta: null, gmail_threads: [],
      counts: { wa_dm: 0, wa_group: 0, wa_group_msg: 0, gmail: 0 },
    }));
  }
  const db = new Database(WACLI_DB, { readonly: true });
  const dmStmt = db.prepare(`
    SELECT chat_name, sender_name, ts, from_me,
           COALESCE(text, display_text, media_caption, '') AS body, media_type
    FROM messages WHERE chat_jid = ? ORDER BY ts DESC LIMIT 30
  `);
  const contactStmt = db.prepare(
    `SELECT push_name, full_name, business_name FROM contacts WHERE jid = ? LIMIT 1`,
  );
  const groupsStmt = db.prepare(`
    SELECT g.jid AS group_jid, g.name AS group_name
    FROM group_participants gp
    JOIN groups g ON g.jid = gp.group_jid
    WHERE gp.user_jid = ? LIMIT 40
  `);
  const groupMsgsStmt = db.prepare(`
    SELECT m.chat_name, m.ts,
           COALESCE(m.text, m.display_text, m.media_caption, '') AS body
    FROM messages m
    WHERE m.chat_jid = ? AND m.sender_jid = ?
    ORDER BY m.ts DESC LIMIT 10
  `);

  const out = [];
  for (const p of persons) {
    const ctx = {
      person_id: p.person_id, name: p.name,
      phones: p.phones, emails: p.emails,
      wa_messages: [], wa_groups: [], wa_group_messages: [],
      wa_contact_meta: null, gmail_threads: [],
      counts: { wa_dm: 0, wa_group: 0, wa_group_msg: 0, gmail: 0 },
    };
    const lidsForPerson = new Set();
    const senderJidsForMsgs = [];
    for (const phone of p.phones) {
      const digits = String(phone).replace(/\D+/g, "");
      if (!digits) continue;
      const dmJid = `${digits}@s.whatsapp.net`;
      senderJidsForMsgs.push(dmJid);
      const meta = contactStmt.get(dmJid);
      if (meta && !ctx.wa_contact_meta) ctx.wa_contact_meta = meta;
      for (const m of dmStmt.all(dmJid)) {
        ctx.wa_messages.push({
          sender: m.from_me ? "me" : (m.sender_name || "them"),
          body: (m.body || "").slice(0, 280),
        });
      }
      const lid = phoneToLid.byPn.get(digits);
      if (lid) lidsForPerson.add(lid);
    }
    for (const lid of lidsForPerson) senderJidsForMsgs.push(`${lid}@lid`);

    const groupJids = new Map();
    for (const jid of senderJidsForMsgs) {
      for (const g of groupsStmt.all(jid)) {
        if (!groupJids.has(g.group_jid)) groupJids.set(g.group_jid, g.group_name);
      }
    }
    ctx.wa_groups = [...new Set([...groupJids.values()].filter(Boolean))].slice(0, 20);

    const gm = [];
    for (const [gid, gname] of groupJids.entries()) {
      for (const jid of senderJidsForMsgs) {
        for (const m of groupMsgsStmt.all(gid, jid)) {
          gm.push({ group: m.chat_name || gname || gid, body: (m.body || "").slice(0, 200) });
        }
      }
    }
    ctx.wa_group_messages = gm.slice(0, 15);

    for (const email of p.emails) {
      const hits = gmailIndex.get(String(email).toLowerCase());
      if (!hits) continue;
      for (const h of hits.slice(0, 4)) {
        ctx.gmail_threads.push({
          from: h.from, to: h.to, subject: h.subject, snippet: (h.snippet || "").slice(0, 220),
        });
      }
    }

    ctx.counts.wa_dm = ctx.wa_messages.length;
    ctx.counts.wa_group = ctx.wa_groups.length;
    ctx.counts.wa_group_msg = ctx.wa_group_messages.length;
    ctx.counts.gmail = ctx.gmail_threads.length;
    out.push(ctx);
  }
  db.close();
  return out;
}

const SYSTEM_PROMPT = `You are an enrichment agent for Orbit, the founder-relationship memory system for Sanchay Thalnerkar (sanchaythalnerkar@gmail.com).

You will receive a JSON array of person contexts. Each context has:
- person_id (UUID — pass through verbatim)
- name, phones, emails
- wa_messages (recent DMs; sender "me" = Sanchay, sender "them" = peer)
- wa_groups (names of shared WhatsApp groups)
- wa_group_messages (their authored messages in groups)
- gmail_threads (subject + snippet of recent email)
- wa_contact_meta (contact card info)

For EACH input person, return ONE object with these fields:
- person_id: string (pass through verbatim)
- category: one of [investor, team, sponsor, fellow, media, community, founder, friend, press, other]
- relationship_to_me: 1-2 sentences in sentence case describing how this person relates to Sanchay. Reference observable evidence. Never write "community member" as a default — name the WHICH community. If evidence is thin, write "Saved contact with no recent direct activity; member of <group>." Do not fabricate.
- company: string or null. Infer from email domain (skip gmail/yahoo/etc.), contact card business_name, or message context.
- title: string or null. Only set if evidence is clear.
- confidence: 0.5-0.95. 0.95 when both channel AND name evidence align; 0.5 when only the saved label is informative.
- reasoning: 1-2 sentences citing specific evidence (group names, email domains, message topics).

Category definitions:
- investor: VC/angel/fund operator who has invested or evaluated investing
- team: current/past coworker, employee, founding team
- sponsor: paying customer, pilot client, sponsor
- fellow: program peer (YC, Antler, Buildspace, IIT, college cohort, fellowship)
- media: newsletter, podcast, journalist counterpart
- community: open-source / dev / slack / discord regular
- founder: another startup founder Sanchay engages peer-to-peer
- friend: personal friend (non-professional context dominates)
- press: working press contact (use rarely; prefer media)
- other: vendors, service providers, one-off or unclassifiable contacts

Safety rules:
- person_id must be the verbatim input UUID. Do not invent ids.
- Never invent companies, titles, or facts not present in context.
- If context is a pure saved phone with no messages/groups/email: category="other", confidence 0.5, "Saved contact, no observed direct interaction in current snapshots."
- Never echo raw phone numbers or full email addresses inside relationship_to_me.
- Return valid JSON only, no prose outside the JSON.

Output: a single JSON object {"results": [<one per input person, in input order>]}.

========================================================================
FEW-SHOT EXAMPLE 1 — program peer via group participation

INPUT:
[{
  "person_id": "aaaaaaaa-1111-2222-3333-444444444444",
  "name": "Priya K",
  "phones": ["+919876543210"],
  "emails": [],
  "wa_contact_meta": {"push_name": "Priya | Buildspace S5"},
  "wa_groups": ["Buildspace S5 Alumni", "NS Nights Mumbai"],
  "wa_messages_sample": [
    {"sender":"them","body":"hey, are you still going to nights tonight?"},
    {"sender":"me","body":"yeah see you there"}
  ],
  "wa_group_messages_sample": [
    {"group":"Buildspace S5 Alumni","body":"demo day prep call at 6pm — room in calendar"}
  ],
  "gmail_threads": []
}]

OUTPUT:
{"results":[{
  "person_id":"aaaaaaaa-1111-2222-3333-444444444444",
  "category":"fellow",
  "relationship_to_me":"Program peer from the Buildspace S5 cohort; also active in the NS Nights Mumbai group and exchanges casual in-person plans with Sanchay.",
  "company":null,
  "title":null,
  "confidence":0.88,
  "reasoning":"Contact card label 'Buildspace S5' plus membership in 'Buildspace S5 Alumni' discussing cohort demo-day logistics — program peer fit is unambiguous."
}]}

========================================================================
FEW-SHOT EXAMPLE 2 — vendor, no program/peer signal

INPUT:
[{
  "person_id":"bbbbbbbb-1111-2222-3333-444444444444",
  "name":"Raj Electrician",
  "phones":["+919000011111"],
  "emails":[],
  "wa_contact_meta":null,
  "wa_groups":[],
  "wa_messages_sample":[
    {"sender":"me","body":"can you come by tomorrow for the fan?"},
    {"sender":"them","body":"yes sir 11am"}
  ],
  "wa_group_messages_sample":[],
  "gmail_threads":[]
}]

OUTPUT:
{"results":[{
  "person_id":"bbbbbbbb-1111-2222-3333-444444444444",
  "category":"other",
  "relationship_to_me":"Electrician Sanchay books for home repair appointments; purely transactional service provider.",
  "company":null,
  "title":"Electrician",
  "confidence":0.8,
  "reasoning":"Saved name 'Raj Electrician' plus DMs are appointment scheduling ('come by tomorrow for the fan'); no group or professional channel."
}]}

========================================================================
FEW-SHOT EXAMPLE 3 — founder peer via group activity

INPUT:
[{
  "person_id":"cccccccc-1111-2222-3333-444444444444",
  "name":"Arjun",
  "phones":["+919111222333"],
  "emails":["arjun@nimbl.ai"],
  "wa_contact_meta":null,
  "wa_groups":["Mumbai Founders Dinner","AI Tinkerers Mumbai"],
  "wa_messages_sample":[],
  "wa_group_messages_sample":[
    {"group":"Mumbai Founders Dinner","body":"anyone know a good design contractor for landing pages?"},
    {"group":"AI Tinkerers Mumbai","body":"shipping our agents v2 next week, grab me if you want to beta"}
  ],
  "gmail_threads":[]
}]

OUTPUT:
{"results":[{
  "person_id":"cccccccc-1111-2222-3333-444444444444",
  "category":"founder",
  "relationship_to_me":"Founder of Nimbl (nimbl.ai); overlaps with Sanchay in Mumbai Founders Dinner and AI Tinkerers circles and ships AI-agent products.",
  "company":"Nimbl",
  "title":"Founder",
  "confidence":0.85,
  "reasoning":"Email domain nimbl.ai + first-person shipping language ('shipping our agents v2') in AI Tinkerers + Mumbai Founders Dinner membership points to peer founder."
}]}
========================================================================`;

function buildUserPrompt(batchContexts) {
  const trimmed = batchContexts.map((c) => ({
    person_id: c.person_id,
    name: c.name,
    phones: c.phones,
    emails: c.emails,
    wa_contact_meta: c.wa_contact_meta,
    wa_groups: c.wa_groups,
    wa_messages_sample: c.wa_messages.slice(0, 10),
    wa_group_messages_sample: c.wa_group_messages.slice(0, 5),
    gmail_threads: c.gmail_threads.slice(0, 3),
  }));
  return `Enrich these ${trimmed.length} persons. Return JSON {"results":[...]} with one object per input (in input order, person_id verbatim).

INPUT:
${JSON.stringify(trimmed, null, 2)}`;
}

function extractJsonText(resp) {
  let raw = "";
  for (const block of resp.content) if (block.type === "text") raw += block.text;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1];
  return raw.trim();
}

function computeBatchCost(usage) {
  return (
    ((usage.input_tokens ?? 0) * PRICE_INPUT +
      (usage.output_tokens ?? 0) * PRICE_OUTPUT +
      (usage.cache_creation_input_tokens ?? 0) * PRICE_CACHE_WRITE +
      (usage.cache_read_input_tokens ?? 0) * PRICE_CACHE_READ) / 1e6
  );
}

const state = {
  anthropic: null,
  effectiveModel: PRIMARY_MODEL,
  modelFallbackLogged: false,
  contextById: new Map(),
  tokenTotals: {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
  costActualUsd: 0,
  emitted: [],
};

async function callLLM(client, batch) {
  try {
    return await client.messages.create({
      model: state.effectiveModel,
      max_tokens: MAX_TOKENS_OUT,
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: buildUserPrompt(batch) }],
    });
  } catch (err) {
    const status = err?.status ?? err?.response?.status ?? 0;
    const msg = err?.message ?? String(err);
    const unknownModel =
      status === 400 &&
      /model|not.*available|invalid/i.test(msg) &&
      state.effectiveModel === PRIMARY_MODEL;
    if (unknownModel) {
      console.error(
        `[enricher-v5] primary model '${PRIMARY_MODEL}' rejected (${status}): ${msg.slice(0, 200)} — falling back to '${FALLBACK_MODEL}'`,
      );
      state.effectiveModel = FALLBACK_MODEL;
      state.modelFallbackLogged = true;
      return client.messages.create({
        model: state.effectiveModel,
        max_tokens: MAX_TOKENS_OUT,
        system: [
          { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: buildUserPrompt(batch) }],
      });
    }
    throw err;
  }
}

function toObservation(ctx, e, observedAt) {
  const validCategories = new Set([
    "investor","team","sponsor","fellow","media","community",
    "founder","friend","press","other",
  ]);
  const category = validCategories.has(e.category) ? e.category : "other";
  const confidence = Math.min(0.95, Math.max(0.5, Number(e.confidence) || 0.6));
  const relationship = String(e.relationship_to_me ?? "").slice(0, 1900);
  const reasoning = String(e.reasoning ?? "Auto-enriched (Haiku v5)").slice(0, 1900)
    || "Auto-enriched (Haiku v5)";
  return {
    observed_at: observedAt,
    observer: "wazowski",
    kind: "person",
    evidence_pointer: `enrichment://enricher-v5/person-${ctx.person_id}`,
    confidence,
    reasoning,
    payload: {
      name: ctx.name,
      phones: ctx.phones ?? [],
      emails: ctx.emails ?? [],
      category,
      title: e.title ? String(e.title).slice(0, 250) : null,
      company: e.company ? String(e.company).slice(0, 250) : null,
      relationship_to_me: relationship,
    },
  };
}

async function processBatch(personIds, { index, attempt }) {
  const contexts = personIds
    .map((pid) => state.contextById.get(pid))
    .filter(Boolean);
  if (contexts.length === 0) return { ok: true, outputs: [] };

  const resp = await callLLM(state.anthropic, contexts);
  const usage = resp.usage ?? {};
  state.tokenTotals.input_tokens += usage.input_tokens ?? 0;
  state.tokenTotals.output_tokens += usage.output_tokens ?? 0;
  state.tokenTotals.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
  state.tokenTotals.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
  state.costActualUsd += computeBatchCost(usage);

  const jsonText = extractJsonText(resp);
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    const err = new Error(
      `JSON parse failed on batch ${index} attempt ${attempt}: ${e.message}`,
    );
    err.code = "JSON_PARSE";
    throw err;
  }
  const arr = Array.isArray(parsed) ? parsed : parsed.results;
  if (!Array.isArray(arr)) {
    const err = new Error(`Batch ${index}: results not an array`);
    err.code = "JSON_PARSE";
    throw err;
  }

  const observedAt = new Date().toISOString();
  const observations = [];
  for (const e of arr) {
    if (!e || !e.person_id) continue;
    const ctx = state.contextById.get(e.person_id);
    if (!ctx) continue;
    observations.push(toObservation(ctx, e, observedAt));
  }
  return { ok: true, outputs: observations };
}

async function emitBatch(observations) {
  if (observations.length === 0) return;
  state.emitted.push(...observations);
  const apiUrl = process.env.ORBIT_API_URL;
  const apiKey = process.env.ORBIT_API_KEY;
  if (!apiUrl || !apiKey) return;
  const url = `${apiUrl.replace(/\/$/, "")}/observations`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(observations),
  });
  if (!r.ok) {
    const body = await r.text();
    const err = new Error(`HTTP ${r.status}: ${body.slice(0, 300)}`);
    err.status = r.status;
    throw err;
  }
}

function classifyError(err) {
  if (!err) return "TRANSIENT";
  if (err.code === "JSON_PARSE") return "PERMANENT";
  const status = err.status ?? err.statusCode;
  if (status === 400 || status === 404) return "PERMANENT";
  return "TRANSIENT";
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  state.anthropic = new Anthropic({ apiKey });

  console.error(`[enricher-v5] loading target persons...`);
  const persons = await loadTargetPersons();
  console.error(`[enricher-v5] ${persons.length} target persons`);

  console.error(`[enricher-v5] building context (LID + gmail)...`);
  const phoneToLid = loadPhoneToLidMap();
  const gmailIndex = loadGmailIndex();
  const contexts = gatherContext(persons, gmailIndex, phoneToLid);
  for (const c of contexts) state.contextById.set(c.person_id, c);
  const targetIds = contexts.map((c) => c.person_id);
  console.error(
    `[enricher-v5] contexts built — will batch ${targetIds.length} persons in ${Math.ceil(targetIds.length / BATCH_SIZE)} batches of ${BATCH_SIZE}`,
  );

  const estCostPerBatch = 0.012;

  const worker = new ResilientWorker({
    runId: `enricher-v5-${DATE_TAG}`,
    outDir: OUT_DIR,
    targets: targetIds,
    batchSize: BATCH_SIZE,
    concurrency: CONCURRENCY,
    processBatch,
    emitBatch,
    retry: { maxAttempts: 3, backoffMs: [5000, 20000, 60000] },
    circuitBreaker: { failureRateThreshold: 0.3, window: 5 },
    budget: { maxCostUSD: BUDGET_USD, maxWallMin: WALL_MIN },
    costPerBatch: estCostPerBatch,
    classifyError,
  });

  const result = await worker.run();

  const summary = {
    run_id: `enricher-v5-${DATE_TAG}`,
    model: state.effectiveModel,
    model_fallback_fired: state.modelFallbackLogged,
    targets: targetIds.length,
    completed: result.completed,
    completedBatches: result.completedBatches,
    quarantined: result.quarantined,
    phase: result.phase,
    wallMinutes: result.wallMinutes,
    cost_estimate_usd: result.cost,
    cost_actual_usd: Number(state.costActualUsd.toFixed(4)),
    tokens: state.tokenTotals,
    cache_hit_ratio_input:
      state.tokenTotals.cache_read_input_tokens /
        Math.max(
          1,
          state.tokenTotals.input_tokens +
            state.tokenTotals.cache_read_input_tokens +
            state.tokenTotals.cache_creation_input_tokens,
        ),
    emitted_count: state.emitted.length,
  };
  fs.writeFileSync(
    path.join(OUT_DIR, "summary.json"),
    JSON.stringify(summary, null, 2),
  );
  fs.writeFileSync(
    path.join(OUT_DIR, "emitted-observations.ndjson"),
    state.emitted.map((o) => JSON.stringify(o)).join("\n") + "\n",
  );
  console.error(
    `[enricher-v5] DONE phase=${result.phase} enriched=${result.completed} cost=$${state.costActualUsd.toFixed(4)} model=${state.effectiveModel}`,
  );
  if (result.phase === "halted_circuit_breaker") process.exit(2);
  if (result.phase === "halted_budget") process.exit(3);
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(thisFile)) {
  main().catch((err) => {
    console.error(`FATAL: ${err.stack || err.message}`);
    process.exit(1);
  });
}

export { processBatch, emitBatch, classifyError, toObservation, SYSTEM_PROMPT };
