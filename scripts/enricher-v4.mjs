#!/usr/bin/env node
/**
 * Enricher V4 — LID-aware re-enrichment of 1,470 "other" persons from Stage-6-v3.
 *
 * Changes vs v3:
 *   1. Loads whatsmeow_lid_map (session.db) and builds a phone to LID map.
 *   2. Gathers group participation & group messages by BOTH phone-jid AND
 *      LID-jid so group-only participants (100% @lid in wacli.db) finally
 *      surface as context.
 *   3. Target set: persons whose latest kind:"person" obs has category='other',
 *      excluding Umayr + Ramon. Expect ~1,470.
 *   4. System prompt padded past 2,048 tokens with 3 few-shot examples so
 *      the prompt cache fires (we confirm via usage.cache_read_input_tokens).
 *   5. Raw-array POST shape /observations (matches v3-repost, not v3's wrapped).
 *
 * Budget: $6 Anthropic, 25 min wall. Either hits first → stop + partial report.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import Database from "better-sqlite3";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "outputs", "stage-6-v4-2026-04-20");
const SNAPSHOT = path.join(ROOT, "openclaw-snapshot", "raw");
const WACLI_DB = path.join(SNAPSHOT, "wacli.db");
const SESSION_DB = path.join(SNAPSHOT, "session.db");
const GMAIL_NDJSON = path.join(SNAPSHOT, "gmail-wide-20260418.messages.ndjson");

const USER_ID = "dbb398c2-1eff-4eee-ae10-bad13be5fda7";
const SKIP_PERSON_IDS = new Set([
  "67050b91-5011-4ba6-b230-9a387879717a", // Umayr
  "9e7c0448-dd3b-437c-9cda-c512dbc5764b", // Ramon (corrected UUID)
]);
const UMAYR_ID = "67050b91-5011-4ba6-b230-9a387879717a";

// Sonnet 4.6 pricing — input $3/MTok, output $15/MTok, cache write 1.25x, cache read 0.1x
const PRICE_INPUT_PER_MTOK = 3.0;
const PRICE_OUTPUT_PER_MTOK = 15.0;
const PRICE_CACHE_WRITE_PER_MTOK = 3.0 * 1.25;
const PRICE_CACHE_READ_PER_MTOK = 3.0 * 0.1;

const BUDGET_USD = 6.0;
const WALLCLOCK_MS = 25 * 60 * 1000;
const BATCH_SIZE = 30;
const LLM_CONCURRENCY = 5;
const MAX_TOKENS_OUT = 16000;

const t0 = Date.now();
const phaseTimings = {};
function startPhase(name) {
  phaseTimings[name] = { start: Date.now() };
  console.error(`[${elapsed()}] === Phase ${name} START ===`);
}
function endPhase(name) {
  phaseTimings[name].end = Date.now();
  phaseTimings[name].ms = phaseTimings[name].end - phaseTimings[name].start;
  console.error(`[${elapsed()}] === Phase ${name} END (${(phaseTimings[name].ms / 1000).toFixed(1)}s) ===`);
}
function elapsed() {
  return `${((Date.now() - t0) / 1000).toFixed(1)}s`;
}
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// --- Phase A ---
async function phaseA() {
  startPhase("A");
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) throw new Error("SUPABASE_DB_URL not set");
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const sql = `
      WITH latest_person_obs AS (
        SELECT DISTINCT ON (link.person_id)
          link.person_id, o.payload
        FROM observations o
        JOIN person_observation_links link ON link.observation_id = o.id
        WHERE o.user_id = $1 AND o.kind = 'person'
        ORDER BY link.person_id, o.observed_at DESC
      )
      SELECT
        p.id::text                                         AS person_id,
        COALESCE(lpo.payload->>'name', 'Unknown')          AS name,
        lpo.payload->'phones'                              AS phones,
        lpo.payload->'emails'                              AS emails
      FROM persons p
      LEFT JOIN latest_person_obs lpo ON lpo.person_id = p.id
      WHERE p.user_id = $1
        AND COALESCE(lpo.payload->>'category', 'other') = 'other'
      ORDER BY p.id;
    `;
    const r = await client.query(sql, [USER_ID]);
    const rows = r.rows
      .filter((row) => !SKIP_PERSON_IDS.has(row.person_id))
      .map((row) => ({
        person_id: row.person_id,
        name: row.name,
        phones: Array.isArray(row.phones) ? row.phones : [],
        emails: Array.isArray(row.emails) ? row.emails : [],
      }));
    const outPath = path.join(OUT_DIR, "target-persons.ndjson");
    fs.writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    console.error(`[${elapsed()}] Phase A: wrote ${rows.length} target persons`);
    endPhase("A");
    return rows;
  } finally {
    await client.end();
  }
}

// --- Phase B ---
function loadPhoneToLidMap() {
  if (!fs.existsSync(SESSION_DB)) throw new Error(`session.db missing at ${SESSION_DB}`);
  const db = new Database(SESSION_DB, { readonly: true });
  const rows = db.prepare("SELECT lid, pn FROM whatsmeow_lid_map").all();
  db.close();
  // pn is UNIQUE in whatsmeow_lid_map, so each phone maps to at most one LID.
  const byPn = new Map();
  const byLid = new Map();
  for (const r of rows) {
    const pn = String(r.pn).trim();
    const lid = String(r.lid).trim();
    if (!pn || !lid) continue;
    byPn.set(pn, lid);
    byLid.set(lid, pn);
  }
  console.error(`[${elapsed()}] Phase B: loaded lid_map — ${byPn.size} pn→lid entries`);
  return { byPn, byLid };
}

function loadGmailIndex() {
  const byEmail = new Map();
  if (!fs.existsSync(GMAIL_NDJSON)) {
    console.error(`[${elapsed()}] Phase B: gmail snapshot missing — skipping email side`);
    return byEmail;
  }
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
    const snippet = m?.snippet ?? "";
    const internalDate = m?.internalDate ?? null;
    const entry = { from, to, subject, date, snippet, internalDate };
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
        if (arr.length < 50) arr.push(entry);
      }
    }
  }
  console.error(`[${elapsed()}] Phase B: gmail index built — ${byEmail.size} emails`);
  return byEmail;
}

function gatherContext(persons, gmailIndex, phoneToLid) {
  if (!fs.existsSync(WACLI_DB)) throw new Error(`wacli.db missing at ${WACLI_DB}`);
  const db = new Database(WACLI_DB, { readonly: true });

  const dmMessagesStmt = db.prepare(`
    SELECT chat_name, sender_name, ts, from_me, COALESCE(text, display_text, media_caption, '') AS body, media_type
    FROM messages WHERE chat_jid = ? ORDER BY ts DESC LIMIT 30
  `);
  const contactStmt = db.prepare(`
    SELECT push_name, full_name, business_name FROM contacts WHERE jid = ? LIMIT 1
  `);
  // Groups this jid participates in (schema: user_jid FK to ... anything; we query by jid string)
  const groupsForJidStmt = db.prepare(`
    SELECT g.jid AS group_jid, g.name AS group_name
    FROM group_participants gp
    JOIN groups g ON g.jid = gp.group_jid
    WHERE gp.user_jid = ? LIMIT 40
  `);
  // Recent messages in a given group by a specific sender_jid.
  // Group sender_jids are consistently '<lid>@lid' (no :device suffix for 99.3%).
  const groupMessagesBySenderStmt = db.prepare(`
    SELECT m.chat_name, m.ts,
           COALESCE(m.text, m.display_text, m.media_caption, '') AS body
    FROM messages m
    WHERE m.chat_jid = ? AND m.sender_jid = ?
    ORDER BY m.ts DESC LIMIT 10
  `);

  const out = [];
  let personsWithGroups = 0;
  let personsWithGroupMsgs = 0;
  let personsWithDms = 0;
  let personsWithGmail = 0;
  let personsEmpty = 0;
  let personsWithLid = 0;

  for (const p of persons) {
    const ctx = {
      person_id: p.person_id, name: p.name,
      phones: p.phones, emails: p.emails,
      wa_messages: [], wa_groups: [], wa_group_messages: [],
      wa_contact_meta: null, gmail_threads: [],
      counts: { wa_dm: 0, wa_group: 0, wa_group_msg: 0, gmail: 0, lids_bridged: 0 },
    };
    const lidsForPerson = new Set();
    for (const phone of p.phones) {
      const digits = String(phone).replace(/\D+/g, "");
      if (!digits) continue;
      const dmJid = `${digits}@s.whatsapp.net`;

      // DM side
      const meta = contactStmt.get(dmJid);
      if (meta && !ctx.wa_contact_meta) ctx.wa_contact_meta = meta;
      const msgs = dmMessagesStmt.all(dmJid);
      for (const m of msgs) {
        ctx.wa_messages.push({
          chat: m.chat_name || dmJid,
          sender: m.from_me ? "me" : (m.sender_name || "them"),
          ts: m.ts,
          body: (m.body || "").slice(0, 280),
          media: m.media_type || null,
        });
      }

      // LID bridge
      const lid = phoneToLid.byPn.get(digits);
      if (lid) lidsForPerson.add(lid);
    }
    ctx.counts.lids_bridged = lidsForPerson.size;
    if (lidsForPerson.size > 0) personsWithLid++;

    // Build full jid set for group-participation + group-message queries
    const senderJidsForMsgs = [];
    for (const phone of p.phones) {
      const digits = String(phone).replace(/\D+/g, "");
      if (!digits) continue;
      senderJidsForMsgs.push(`${digits}@s.whatsapp.net`);
    }
    for (const lid of lidsForPerson) senderJidsForMsgs.push(`${lid}@lid`);

    // Collect distinct group_jids across all identities
    const groupJidsSeen = new Map(); // group_jid -> group_name
    for (const jid of senderJidsForMsgs) {
      const groups = groupsForJidStmt.all(jid);
      for (const g of groups) {
        if (!groupJidsSeen.has(g.group_jid)) {
          groupJidsSeen.set(g.group_jid, g.group_name || null);
        }
      }
    }
    ctx.wa_groups = [...new Set([...groupJidsSeen.values()].filter(Boolean))].slice(0, 30);

    // Pull recent messages BY this person in those groups
    const groupMsgsCollected = [];
    for (const [groupJid, groupName] of groupJidsSeen.entries()) {
      for (const jid of senderJidsForMsgs) {
        const msgs = groupMessagesBySenderStmt.all(groupJid, jid);
        for (const m of msgs) {
          groupMsgsCollected.push({
            group: m.chat_name || groupName || groupJid,
            ts: m.ts,
            body: (m.body || "").slice(0, 200),
          });
        }
      }
    }
    groupMsgsCollected.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    ctx.wa_group_messages = groupMsgsCollected.slice(0, 20);

    // Gmail side
    for (const email of p.emails) {
      const lower = String(email).toLowerCase();
      const hits = gmailIndex.get(lower);
      if (!hits) continue;
      for (const h of hits.slice(0, 5)) {
        ctx.gmail_threads.push({
          from: h.from, to: h.to, subject: h.subject, date: h.date,
          snippet: (h.snippet || "").slice(0, 240),
        });
      }
    }

    ctx.wa_messages = ctx.wa_messages.slice(0, 30);
    ctx.gmail_threads = ctx.gmail_threads.slice(0, 5);

    ctx.counts.wa_dm = ctx.wa_messages.length;
    ctx.counts.wa_group = ctx.wa_groups.length;
    ctx.counts.wa_group_msg = ctx.wa_group_messages.length;
    ctx.counts.gmail = ctx.gmail_threads.length;

    if (ctx.counts.wa_dm) personsWithDms++;
    if (ctx.counts.wa_group) personsWithGroups++;
    if (ctx.counts.wa_group_msg) personsWithGroupMsgs++;
    if (ctx.counts.gmail) personsWithGmail++;
    if (!ctx.counts.wa_dm && !ctx.counts.wa_group && !ctx.counts.gmail) personsEmpty++;

    out.push(ctx);
  }
  db.close();
  console.error(`[${elapsed()}] Phase B: ctx=${out.length} withDMs=${personsWithDms} withGroups=${personsWithGroups} withGroupMsgs=${personsWithGroupMsgs} withGmail=${personsWithGmail} empty=${personsEmpty} lidBridged=${personsWithLid}`);
  return out;
}

async function phaseB(persons) {
  startPhase("B");
  const phoneToLid = loadPhoneToLidMap();
  const gmailIndex = loadGmailIndex();
  const ctxs = gatherContext(persons, gmailIndex, phoneToLid);
  const outPath = path.join(OUT_DIR, "contexts-v4.ndjson");
  fs.writeFileSync(outPath, ctxs.map((c) => JSON.stringify(c)).join("\n") + "\n");
  endPhase("B");
  return ctxs;
}

// --- Phase C ---
const SYSTEM_PROMPT = `You are an enrichment agent for Orbit, the founder-relationship memory system for Sanchay Thalnerkar (sanchaythalnerkar@gmail.com).

You will receive a JSON array of person contexts. Each context has:
- person_id (UUID — pass through verbatim)
- name (their saved label — may be a nickname, business, or display name)
- phones, emails
- wa_messages: recent WhatsApp DMs (sender "me" = Sanchay; sender "them" = the person)
- wa_groups: WhatsApp groups they share with Sanchay
- wa_group_messages: their messages in shared groups
- gmail_threads: subject + snippet of recent emails to/from Sanchay
- wa_contact_meta: contact card name (if any)

For EACH input person, return ONE object with these fields:
- person_id: string (pass through verbatim from input)
- category: one of [investor, team, sponsor, fellow, media, community, founder, friend, press, other]
- relationship_to_me: 1-2 sentences in sentence case describing how this person relates to Sanchay. Be specific — reference observable evidence (group names, topics, channel). DO NOT fabricate. If evidence is thin, write a one-sentence honest summary like "Saved contact with no recent direct activity; member of <group>." Never write "community member" as a default — explain WHICH community.
- company: string or null. Infer from email domain (skip gmail/yahoo/etc.), business contact card name, or message context. Null if unclear.
- title: string or null. Only set if the message/group/email clearly implies a role.
- confidence: number 0.5-0.95. 0.95 only when both channel evidence AND name evidence point the same way; 0.5 when only the saved label is informative.
- reasoning: 1-2 sentences citing the specific evidence used (e.g. "Member of 'IIT Bombay AI Fellows' group; messages discuss research; email domain is iitb.ac.in.").

Category definitions:
- investor: VC/angel/fund operator, has invested or evaluated investing
- team: current/past co-worker, employee, founding team
- sponsor: paying customer, pilot client, sponsor of a project
- fellow: program peer (YC, Antler, Buildspace, IIT, college cohort, fellowship)
- media: newsletter, podcast host/guest counterpart, journalist
- community: open-source/dev community member, slack/discord regular
- founder: another startup founder Sanchay engages with peer-to-peer
- friend: personal friend (non-professional context dominates)
- press: press contact, journalist with whom there is a working relationship (use rarely; prefer media)
- other: vendors, service providers (salons, banks, mechanics), one-off contacts, unclassifiable

Safety rules:
- person_id must be returned verbatim from the input. Do not invent IDs.
- Never invent companies, titles, or facts not present in the context.
- If the context is purely a saved phone number with no messages, no group, no email — set category to "other", confidence 0.5, and write an honest "Saved contact, no observed direct interaction in current snapshots." sentence.
- Never echo PII like phone numbers or full email addresses inside relationship_to_me unless they are part of a name (e.g., "kapils-salon" is fine).
- Always return valid JSON. No prose outside the JSON.

Output format: a single JSON object {"results": [<one object per input person, in the same order>]}.

========================================================================
FEW-SHOT EXAMPLE 1 — program peer surfaced via group participation

INPUT:
[{
  "person_id": "aaaaaaaa-1111-2222-3333-444444444444",
  "name": "Priya K",
  "phones": ["+919876543210"],
  "emails": [],
  "wa_contact_meta": { "push_name": "Priya | Buildspace S5" },
  "wa_groups": ["Buildspace S5 Alumni", "NS Nights Mumbai"],
  "wa_messages_sample": [
    { "sender": "them", "body": "hey, are you still going to nights tonight?" },
    { "sender": "me", "body": "yeah see you there" }
  ],
  "wa_group_messages_sample": [
    { "group": "Buildspace S5 Alumni", "body": "demo day prep call at 6pm today — room link in calendar" }
  ],
  "gmail_threads": []
}]

OUTPUT:
{"results":[{
  "person_id": "aaaaaaaa-1111-2222-3333-444444444444",
  "category": "fellow",
  "relationship_to_me": "Program peer from the Buildspace S5 cohort; also active in the NS Nights Mumbai group and exchanges casual in-person plans with Sanchay.",
  "company": null,
  "title": null,
  "confidence": 0.88,
  "reasoning": "Contact card label 'Buildspace S5' plus membership in the 'Buildspace S5 Alumni' group discussing cohort-internal demo-day logistics — program-peer fit is unambiguous."
}]}

========================================================================
FEW-SHOT EXAMPLE 2 — vendor, no program/peer signal

INPUT:
[{
  "person_id": "bbbbbbbb-1111-2222-3333-444444444444",
  "name": "Raj Electrician",
  "phones": ["+919000011111"],
  "emails": [],
  "wa_contact_meta": null,
  "wa_groups": [],
  "wa_messages_sample": [
    { "sender": "me", "body": "can you come by tomorrow for the fan?" },
    { "sender": "them", "body": "yes sir 11am" }
  ],
  "wa_group_messages_sample": [],
  "gmail_threads": []
}]

OUTPUT:
{"results":[{
  "person_id": "bbbbbbbb-1111-2222-3333-444444444444",
  "category": "other",
  "relationship_to_me": "Electrician Sanchay books for home repair appointments; purely transactional service provider.",
  "company": null,
  "title": "Electrician",
  "confidence": 0.8,
  "reasoning": "Saved name 'Raj Electrician' plus DMs are appointment scheduling ('come by tomorrow for the fan'); no group or professional channel signal."
}]}

========================================================================
FEW-SHOT EXAMPLE 3 — founder peer surfaced only via group activity

INPUT:
[{
  "person_id": "cccccccc-1111-2222-3333-444444444444",
  "name": "Arjun",
  "phones": ["+919111222333"],
  "emails": ["arjun@nimbl.ai"],
  "wa_contact_meta": null,
  "wa_groups": ["Mumbai Founders Dinner", "AI Tinkerers Mumbai"],
  "wa_messages_sample": [],
  "wa_group_messages_sample": [
    { "group": "Mumbai Founders Dinner", "body": "anyone know a good design contractor for landing pages?" },
    { "group": "AI Tinkerers Mumbai", "body": "shipping our agents v2 next week, grab me if you want to beta" }
  ],
  "gmail_threads": []
}]

OUTPUT:
{"results":[{
  "person_id": "cccccccc-1111-2222-3333-444444444444",
  "category": "founder",
  "relationship_to_me": "Founder of Nimbl (nimbl.ai); overlaps with Sanchay in the Mumbai Founders Dinner and AI Tinkerers Mumbai circles and ships AI-agent products.",
  "company": "Nimbl",
  "title": "Founder",
  "confidence": 0.85,
  "reasoning": "Email domain nimbl.ai plus first-person shipping language ('shipping our agents v2') in the AI Tinkerers group, combined with Mumbai Founders Dinner membership, points to peer-founder."
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
    wa_messages_sample: c.wa_messages.slice(0, 12).map((m) => ({
      sender: m.sender, body: m.body, media: m.media,
    })),
    wa_group_messages_sample: c.wa_group_messages.slice(0, 5).map((m) => ({
      group: m.group, body: m.body,
    })),
    gmail_threads: c.gmail_threads.slice(0, 4).map((t) => ({
      from: t.from, to: t.to, subject: t.subject, snippet: t.snippet,
    })),
  }));
  return `Enrich these ${trimmed.length} persons. Return JSON object {"results":[...]} with one object per input, in input order, person_id verbatim.

INPUT:
${JSON.stringify(trimmed, null, 2)}`;
}

async function callLLM(client, batch, attempt = 1) {
  try {
    return await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: MAX_TOKENS_OUT,
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: buildUserPrompt(batch) }],
    });
  } catch (err) {
    const status = err?.status ?? err?.response?.status ?? 0;
    const retryable = status === 429 || (status >= 500 && status < 600) || err?.name === "AbortError";
    if (retryable && attempt < 3) {
      const wait = 2000 * attempt;
      console.error(`[${elapsed()}] LLM retry ${attempt} after ${wait}ms — status=${status}: ${err?.message ?? err}`);
      await new Promise((r) => setTimeout(r, wait));
      return callLLM(client, batch, attempt + 1);
    }
    throw err;
  }
}

function extractJsonText(resp) {
  let raw = "";
  for (const block of resp.content) if (block.type === "text") raw += block.text;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1];
  return raw.trim();
}

async function phaseC(contexts) {
  startPhase("C");
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const client = new Anthropic({ apiKey });

  const batches = chunk(contexts, BATCH_SIZE);
  console.error(`[${elapsed()}] Phase C: ${batches.length} batches × ${BATCH_SIZE}, concurrency ${LLM_CONCURRENCY}`);

  const results = new Array(batches.length).fill(null);
  const tokenTotals = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  let costEstimateUsd = 0;
  let nextIdx = 0;
  let aborted = false;
  let abortReason = null;

  // Warm cache: send the FIRST batch alone before launching workers, so that
  // subsequent concurrent calls hit the prompt cache (cache becomes readable
  // only after first response begins streaming).
  console.error(`[${elapsed()}] Phase C: warming cache with batch 0...`);
  try {
    const warmResp = await callLLM(client, batches[0]);
    const usage = warmResp.usage ?? {};
    tokenTotals.input_tokens += usage.input_tokens ?? 0;
    tokenTotals.output_tokens += usage.output_tokens ?? 0;
    tokenTotals.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
    tokenTotals.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
    const batchCost =
      ((usage.input_tokens ?? 0) * PRICE_INPUT_PER_MTOK +
        (usage.output_tokens ?? 0) * PRICE_OUTPUT_PER_MTOK +
        (usage.cache_creation_input_tokens ?? 0) * PRICE_CACHE_WRITE_PER_MTOK +
        (usage.cache_read_input_tokens ?? 0) * PRICE_CACHE_READ_PER_MTOK) / 1e6;
    costEstimateUsd += batchCost;
    const jsonText = extractJsonText(warmResp);
    const parsed = JSON.parse(jsonText);
    const arr = Array.isArray(parsed) ? parsed : parsed.results;
    results[0] = { batchIdx: 0, arr, batchCost, usage };
    nextIdx = 1;
    console.error(`[${elapsed()}] Phase C: warm batch ok (${arr.length} results, $${batchCost.toFixed(4)}, in=${usage.input_tokens} out=${usage.output_tokens} cW=${usage.cache_creation_input_tokens})`);
  } catch (err) {
    console.error(`[${elapsed()}] Phase C: WARM batch FAILED: ${err.message}`);
    results[0] = { batchIdx: 0, error: err.message };
    nextIdx = 1;
  }

  async function worker() {
    while (true) {
      if (aborted) return;
      if (Date.now() - t0 > WALLCLOCK_MS) {
        aborted = true; abortReason = `wallclock ceiling ${WALLCLOCK_MS / 60000}min hit`; return;
      }
      if (costEstimateUsd > BUDGET_USD) {
        aborted = true; abortReason = `budget ceiling $${BUDGET_USD} hit (current $${costEstimateUsd.toFixed(2)})`; return;
      }
      const idx = nextIdx++;
      if (idx >= batches.length) return;
      const batch = batches[idx];
      try {
        const resp = await callLLM(client, batch);
        const usage = resp.usage ?? {};
        tokenTotals.input_tokens += usage.input_tokens ?? 0;
        tokenTotals.output_tokens += usage.output_tokens ?? 0;
        tokenTotals.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
        tokenTotals.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
        const batchCost =
          ((usage.input_tokens ?? 0) * PRICE_INPUT_PER_MTOK +
            (usage.output_tokens ?? 0) * PRICE_OUTPUT_PER_MTOK +
            (usage.cache_creation_input_tokens ?? 0) * PRICE_CACHE_WRITE_PER_MTOK +
            (usage.cache_read_input_tokens ?? 0) * PRICE_CACHE_READ_PER_MTOK) / 1e6;
        costEstimateUsd += batchCost;

        const jsonText = extractJsonText(resp);
        let parsed;
        try { parsed = JSON.parse(jsonText); }
        catch (e) { throw new Error(`Batch ${idx}: JSON parse failed: ${e.message}; raw start=${jsonText.slice(0, 200)}`); }
        const arr = Array.isArray(parsed) ? parsed : parsed.results;
        if (!Array.isArray(arr)) throw new Error(`Batch ${idx}: results not an array`);
        results[idx] = { batchIdx: idx, arr, batchCost, usage };
        console.error(`[${elapsed()}] Phase C: batch ${idx + 1}/${batches.length} ok (${arr.length} results, $${batchCost.toFixed(4)}, total $${costEstimateUsd.toFixed(2)}, in=${usage.input_tokens} out=${usage.output_tokens} cR=${usage.cache_read_input_tokens})`);
      } catch (err) {
        console.error(`[${elapsed()}] Phase C: batch ${idx} FAILED: ${err.message}`);
        results[idx] = { batchIdx: idx, error: err.message };
      }
    }
  }

  await Promise.all(Array.from({ length: LLM_CONCURRENCY }, worker));

  const enrichedById = new Map();
  for (const r of results) {
    if (!r || r.error) continue;
    for (const e of r.arr) {
      if (!e || !e.person_id) continue;
      enrichedById.set(e.person_id, e);
    }
  }
  const failedBatches = results.filter((r) => r && r.error);
  console.error(`[${elapsed()}] Phase C done. enriched=${enrichedById.size}/${contexts.length}; failedBatches=${failedBatches.length}; cost=$${costEstimateUsd.toFixed(3)}; aborted=${aborted ? abortReason : "no"}`);
  endPhase("C");
  return { enrichedById, failedBatches, tokenTotals, costEstimateUsd, aborted, abortReason };
}

// --- Phase D ---
async function phaseD(contexts, enrichedById) {
  startPhase("D");
  const obsPath = path.join(OUT_DIR, "enriched-observations-v4.ndjson");
  const out = [];
  const observedAt = new Date().toISOString();
  const validCategories = new Set(["investor","team","sponsor","fellow","media","community","founder","friend","press","other"]);

  for (const c of contexts) {
    if (SKIP_PERSON_IDS.has(c.person_id)) continue;
    const e = enrichedById.get(c.person_id);
    if (!e) continue;
    const category = validCategories.has(e.category) ? e.category : "other";
    const confidence = Math.min(0.95, Math.max(0.5, Number(e.confidence) || 0.6));
    const reasoning = String(e.reasoning ?? "Auto-enriched from snapshot").slice(0, 1900) || "Auto-enriched from snapshot";
    const relationship = String(e.relationship_to_me ?? "").slice(0, 1900);
    out.push({
      observed_at: observedAt,
      observer: "wazowski",
      kind: "person",
      evidence_pointer: `enrichment://stage-6-v4-2026-04-20/person-${c.person_id}`,
      confidence,
      reasoning,
      payload: {
        name: c.name,
        phones: c.phones ?? [],
        emails: c.emails ?? [],
        category,
        title: e.title ? String(e.title).slice(0, 250) : null,
        company: e.company ? String(e.company).slice(0, 250) : null,
        relationship_to_me: relationship,
      },
    });
  }
  fs.writeFileSync(obsPath, out.map((o) => JSON.stringify(o)).join("\n") + "\n");
  console.error(`[${elapsed()}] Phase D: wrote ${out.length} observations`);

  const apiUrl = process.env.ORBIT_API_URL;
  const apiKey = process.env.ORBIT_API_KEY;
  if (!apiUrl || !apiKey) {
    console.error(`[${elapsed()}] Phase D: ORBIT_API_URL/KEY missing — skipping POST`);
    endPhase("D");
    return { posted: false, total: out.length, inserted: 0, deduped: 0, failed_batches: [] };
  }

  const url = `${apiUrl.replace(/\/$/, "")}/observations`;
  const chunks = chunk(out, 100);
  let inserted = 0, deduped = 0;
  const failedBatches = [];
  for (let i = 0; i < chunks.length; i++) {
    // Raw array shape per v3-repost finding (v3's wrapped shape was rejected).
    const body = JSON.stringify(chunks[i]);
    let attempt = 0;
    let success = false;
    let lastErr = null;
    while (attempt < 2 && !success) {
      attempt++;
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body,
        });
        const text = await r.text();
        if (!r.ok) {
          lastErr = `HTTP ${r.status}: ${text.slice(0, 300)}`;
          if (r.status >= 500 && attempt < 2) { await new Promise((res) => setTimeout(res, 1500)); continue; }
          throw new Error(lastErr);
        }
        const json = JSON.parse(text);
        inserted += json.inserted ?? 0;
        deduped += json.deduped ?? 0;
        success = true;
        console.error(`[${elapsed()}] Phase D: batch ${i + 1}/${chunks.length} → inserted=${json.inserted} deduped=${json.deduped}`);
      } catch (e) { lastErr = e.message; }
    }
    if (!success) {
      failedBatches.push({ batch_index: i, count: chunks[i].length, error: lastErr });
      console.error(`[${elapsed()}] Phase D: batch ${i + 1} FAILED — ${lastErr}`);
    }
  }
  endPhase("D");
  return { posted: true, total: out.length, inserted, deduped, failed_batches: failedBatches };
}

// --- Phase E ---
async function fetchCard(personId) {
  const apiUrl = process.env.ORBIT_API_URL;
  const apiKey = process.env.ORBIT_API_KEY;
  const r = await fetch(`${apiUrl.replace(/\/$/, "")}/person/${personId}/card`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!r.ok) return { error: `HTTP ${r.status}` };
  return r.json();
}

function diff(a, b) {
  const changes = [];
  function walk(x, y, p) {
    if (typeof x !== typeof y) { changes.push({ path: p, before: x, after: y }); return; }
    if (x === null || typeof x !== "object") { if (x !== y) changes.push({ path: p, before: x, after: y }); return; }
    if (Array.isArray(x)) {
      if (!Array.isArray(y) || x.length !== y.length) { changes.push({ path: p, before: x, after: y }); return; }
      for (let i = 0; i < x.length; i++) walk(x[i], y[i], `${p}[${i}]`);
      return;
    }
    const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
    for (const k of keys) walk(x[k], y[k], `${p}.${k}`);
  }
  walk(a, b, "");
  return changes;
}

async function phaseE(enrichedById) {
  startPhase("E");
  const apiUrl = process.env.ORBIT_API_URL;
  if (!apiUrl) {
    console.error(`[${elapsed()}] Phase E: ORBIT_API_URL missing — skipping`);
    endPhase("E");
    return { audit: [], canary: { ok: true, note: "skipped" } };
  }
  const enrichedIds = [...enrichedById.keys()].filter((id) => !SKIP_PERSON_IDS.has(id));
  // Prefer sampling from the "upgraded" set — new category != "other"
  const notOther = enrichedIds.filter((id) => {
    const e = enrichedById.get(id);
    return e?.category && e.category !== "other";
  });
  const pool = [...(notOther.length >= 15 ? notOther : enrichedIds)];
  const sampled = [];
  for (let i = 0; i < Math.min(15, pool.length); i++) {
    const idx = Math.floor(Math.random() * pool.length);
    sampled.push(pool.splice(idx, 1)[0]);
  }
  const audit = [];
  for (const pid of sampled) {
    const enriched = enrichedById.get(pid);
    const card = await fetchCard(pid);
    audit.push({
      person_id: pid,
      llm_category: enriched?.category,
      llm_relationship: enriched?.relationship_to_me,
      card_category: card?.card?.category,
      card_relationship: card?.card?.relationship_to_me,
      card_company: card?.card?.company,
      card_title: card?.card?.title,
    });
  }
  const baselinePath = path.join(ROOT, "outputs", "verification", "2026-04-19-umayr-v0", "card.json");
  let canary = { ok: true };
  if (fs.existsSync(baselinePath)) {
    const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf-8"));
    const fresh = await fetchCard(UMAYR_ID);
    if (fresh?.error) {
      canary = { ok: false, error: fresh.error };
    } else {
      const stableKeys = ["name", "company", "title", "category", "phones", "emails", "relationship_to_me"];
      const changes = [];
      for (const k of stableKeys) {
        const a = baseline?.card?.[k];
        const b = fresh?.card?.[k];
        if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ path: k, before: a, after: b });
      }
      canary = { ok: changes.length === 0, diff: changes };
    }
  } else {
    canary = { ok: true, note: "baseline missing — skipping canary" };
  }
  console.error(`[${elapsed()}] Phase E: audit=${audit.length}, canary=${canary.ok ? "PASS" : "FAIL"}`);
  endPhase("E");
  return { audit, canary };
}

// --- Category distribution (before/after) ---
async function fetchCategoryDistribution() {
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) return null;
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const sql = `
      WITH latest_person_obs AS (
        SELECT DISTINCT ON (link.person_id) link.person_id, o.payload
        FROM observations o
        JOIN person_observation_links link ON link.observation_id = o.id
        WHERE o.user_id = $1 AND o.kind = 'person'
        ORDER BY link.person_id, o.observed_at DESC
      )
      SELECT COALESCE(lpo.payload->>'category', 'NO_OBS') AS cat, COUNT(*)::int AS n
      FROM persons p LEFT JOIN latest_person_obs lpo ON lpo.person_id = p.id
      WHERE p.user_id = $1
      GROUP BY cat ORDER BY 2 DESC;
    `;
    const r = await client.query(sql, [USER_ID]);
    return r.rows;
  } finally {
    await client.end();
  }
}

// --- Report ---
function writeReport(meta) {
  const reportPath = path.join(OUT_DIR, "report.md");
  const summaryPath = path.join(OUT_DIR, "summary.json");
  const timingsPath = path.join(OUT_DIR, "phase-timings.json");
  fs.writeFileSync(timingsPath, JSON.stringify(phaseTimings, null, 2));
  fs.writeFileSync(summaryPath, JSON.stringify(meta, null, 2));

  const auditTable = (meta.audit ?? []).map((a) =>
    `| ${a.person_id.slice(0, 8)} | ${a.card_category ?? "-"} | ${(a.card_relationship ?? "").slice(0, 90).replace(/\|/g, "\\|")} | ${a.card_company ?? "-"} | ${a.card_title ?? "-"} |`
  ).join("\n");

  const cacheTotal = (meta.tokens.cache_read_input_tokens ?? 0) + (meta.tokens.input_tokens ?? 0) + (meta.tokens.cache_creation_input_tokens ?? 0);
  const cacheHitRate = cacheTotal > 0
    ? ((meta.tokens.cache_read_input_tokens / cacheTotal) * 100).toFixed(1)
    : "0.0";

  const beforeTable = (meta.before_dist ?? []).map((r) => `- ${r.cat}: ${r.n}`).join("\n");
  const afterTable = (meta.after_dist ?? []).map((r) => `- ${r.cat}: ${r.n}`).join("\n");

  const md = `# Stage 6 V4 — LID-aware Enrichment Report

**Verdict:** \`${meta.verdict}\`
**Run started:** ${new Date(t0).toISOString()}
**Wall-clock:** ${((Date.now() - t0) / 1000).toFixed(1)}s

## Phase timings
${Object.entries(phaseTimings).map(([k, v]) => `- Phase ${k}: ${(v.ms / 1000).toFixed(1)}s`).join("\n")}

## Target set
- Target persons (category='other', excl Umayr+Ramon): **${meta.targetCount}**
- Contexts gathered: ${meta.contextCount}
- Enriched: ${meta.enrichedCount}
- Failed LLM batches: ${meta.failedBatchCount}
- Observations written: ${meta.obsWritten}
- Observations inserted: ${meta.inserted}
- Observations deduped: ${meta.deduped}
- POST failed batches: ${meta.postFailedBatches}

## Context coverage (LID-bridge effect)
- Persons with WA DMs: ${meta.ctxStats?.withDms ?? "-"}
- Persons with WA groups: ${meta.ctxStats?.withGroups ?? "-"}
- Persons with WA group messages: ${meta.ctxStats?.withGroupMsgs ?? "-"}
- Persons with Gmail threads: ${meta.ctxStats?.withGmail ?? "-"}
- Persons with zero signal: ${meta.ctxStats?.empty ?? "-"}
- Persons with at least one LID bridged: ${meta.ctxStats?.withLid ?? "-"}

## Token usage
- Input tokens: ${meta.tokens.input_tokens.toLocaleString()}
- Output tokens: ${meta.tokens.output_tokens.toLocaleString()}
- Cache write tokens: ${meta.tokens.cache_creation_input_tokens.toLocaleString()}
- Cache read tokens: ${meta.tokens.cache_read_input_tokens.toLocaleString()}
- **Prompt cache hit rate: ${cacheHitRate}%** (Fix #3)
- **Estimated cost: $${meta.cost.toFixed(3)}**

## Before/after category distribution
### Before
${beforeTable}

### After
${afterTable}

## Sample audit (${(meta.audit ?? []).length} cards)
| person_id | category | relationship_to_me (truncated) | company | title |
|-----------|----------|-------------------------------|---------|-------|
${auditTable}

## Umayr canary
- ok: ${meta.canary.ok}
- detail: ${JSON.stringify(meta.canary).slice(0, 1800)}

## Notes
${(meta.notes ?? []).map((n) => `- ${n}`).join("\n")}
`;
  fs.writeFileSync(reportPath, md);
  console.error(`[${elapsed()}] Report → ${reportPath}`);
}

// --- Main ---
async function main() {
  ensureDir(OUT_DIR);
  const notes = [];

  const beforeDist = await fetchCategoryDistribution();
  notes.push(`Before dist: ${JSON.stringify(beforeDist)}`);

  const persons = await phaseA();
  const contexts = await phaseB(persons);

  const ctxStats = {
    withDms: contexts.filter((c) => c.counts.wa_dm > 0).length,
    withGroups: contexts.filter((c) => c.counts.wa_group > 0).length,
    withGroupMsgs: contexts.filter((c) => c.counts.wa_group_msg > 0).length,
    withGmail: contexts.filter((c) => c.counts.gmail > 0).length,
    empty: contexts.filter((c) => c.counts.wa_dm === 0 && c.counts.wa_group === 0 && c.counts.gmail === 0).length,
    withLid: contexts.filter((c) => c.counts.lids_bridged > 0).length,
  };
  notes.push(`Context stats: ${JSON.stringify(ctxStats)}`);

  const c = await phaseC(contexts);

  let postResult = { posted: false, total: 0, inserted: 0, deduped: 0, failed_batches: [] };

  let proceedToD = true;
  const allEnriched = [...c.enrichedById.values()];
  if (allEnriched.length === 0) {
    proceedToD = false;
    notes.push("No enriched results — skipping Phase D.");
  } else {
    let vague = 0;
    const checkSample = allEnriched.slice(0, Math.min(50, allEnriched.length));
    for (const ee of checkSample) {
      const rel = (ee.relationship_to_me ?? "").toLowerCase();
      if (!rel || rel.includes("community member") || rel.length < 20) vague++;
    }
    const vagueRatio = vague / checkSample.length;
    notes.push(`Pre-D quality sample: ${vague}/${checkSample.length} vague (${(vagueRatio * 100).toFixed(0)}%).`);
    if (vagueRatio > 0.30) {
      proceedToD = false;
      notes.push("STOP: vague-ratio > 30%. Skipping Phase D.");
    }
  }

  if (proceedToD) postResult = await phaseD(contexts, c.enrichedById);
  else notes.push("Phase D skipped due to quality gate.");

  const e = await phaseE(c.enrichedById);

  const afterDist = await fetchCategoryDistribution();

  let verdict;
  if (c.aborted) verdict = `STAGE6_V4_HALT: ${c.abortReason}`;
  else if (!proceedToD) verdict = "STAGE6_V4_PARTIAL: quality gate failed — no DB writes";
  else if (postResult.failed_batches.length > 0 || c.failedBatches.length > 0) {
    verdict = `STAGE6_V4_PARTIAL: ${c.failedBatches.length} LLM batches failed, ${postResult.failed_batches.length} POST batches failed`;
  } else if (!e.canary.ok) verdict = "STAGE6_V4_PARTIAL: Umayr canary regressed";
  else verdict = "STAGE6_V4_PASS";

  writeReport({
    verdict,
    targetCount: persons.length,
    contextCount: contexts.length,
    enrichedCount: c.enrichedById.size,
    failedBatchCount: c.failedBatches.length,
    obsWritten: postResult.total,
    inserted: postResult.inserted,
    deduped: postResult.deduped,
    postFailedBatches: postResult.failed_batches.length,
    tokens: c.tokenTotals,
    cost: c.costEstimateUsd,
    audit: e.audit,
    canary: e.canary,
    ctxStats,
    before_dist: beforeDist,
    after_dist: afterDist,
    notes,
  });

  console.error(`\n=== ${verdict} ===\n`);
}

main().catch((err) => {
  console.error(`FATAL: ${err.stack || err.message}`);
  try {
    writeReport({
      verdict: `STAGE6_V4_HALT: ${err.message}`,
      targetCount: 0, contextCount: 0, enrichedCount: 0, failedBatchCount: 0,
      obsWritten: 0, inserted: 0, deduped: 0, postFailedBatches: 0,
      tokens: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      cost: 0, audit: [], canary: { ok: false, error: "halted before audit" },
      ctxStats: { withDms: 0, withGroups: 0, withGroupMsgs: 0, withGmail: 0, empty: 0, withLid: 0 },
      before_dist: [], after_dist: [],
      notes: [`Fatal: ${err.stack || err.message}`],
    });
  } catch {}
  process.exit(1);
});
