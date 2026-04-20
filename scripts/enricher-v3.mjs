#!/usr/bin/env node
/**
 * Enricher V3 — batched LLM enrichment of 1,598 skeleton person cards.
 *
 * Architecture (departs from killed Stage-6 sequential):
 *   A. Pull skeleton cards from DB (id, name, phones, emails)
 *   B. Gather per-person context from local snapshots (wacli.db + gmail-wide NDJSON)
 *      via direct sqlite + NDJSON reads. concurrency over Promise.all chunks.
 *   C. Batched LLM enrichment via Anthropic claude-sonnet-4-6 with cached system prompt
 *      — concurrency=5 over batches of 30 persons each
 *   D. Emit observations as NDJSON, then POST in chunks of 100 to /observations
 *      (the same endpoint orbit_observation_bulk uses)
 *   E. Sample-audit + Umayr canary diff
 *
 * Inputs:
 *   - SUPABASE_DB_URL (required)
 *   - ORBIT_API_URL + ORBIT_API_KEY (required for Phase D + E)
 *   - ANTHROPIC_API_KEY (required for Phase C)
 *
 * Outputs (under outputs/stage-6-v3-2026-04-20/):
 *   - skeleton-persons.ndjson
 *   - contexts.ndjson
 *   - enriched-observations.ndjson
 *   - report.md
 *   - summary.json
 *   - phase-timings.json
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
const OUT_DIR = path.join(ROOT, "outputs", "stage-6-v3-2026-04-20");
const SNAPSHOT = path.join(ROOT, "openclaw-snapshot", "raw");
const WACLI_DB = path.join(SNAPSHOT, "wacli.db");
const GMAIL_NDJSON = path.join(SNAPSHOT, "gmail-wide-20260418.messages.ndjson");

const USER_ID = "dbb398c2-1eff-4eee-ae10-bad13be5fda7";
const SKIP_PERSON_IDS = new Set([
  "67050b91-5011-4ba6-b230-9a387879717a", // Umayr
  "9e7c0448-8a83-43d5-83b1-bfa4f6c40ba7", // Ramon (best guess from baseline filename)
]);

// Sonnet 4.6 pricing — input $3/MTok, output $15/MTok, cache write 1.25x, cache read 0.1x
const PRICE_INPUT_PER_MTOK = 3.0;
const PRICE_OUTPUT_PER_MTOK = 15.0;
const PRICE_CACHE_WRITE_PER_MTOK = 3.0 * 1.25;
const PRICE_CACHE_READ_PER_MTOK = 3.0 * 0.1;

const BUDGET_USD = 8.0;
const WALLCLOCK_MS = 30 * 60 * 1000;
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
    const outPath = path.join(OUT_DIR, "skeleton-persons.ndjson");
    fs.writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    console.error(`[${elapsed()}] Phase A: wrote ${rows.length} skeleton persons`);
    endPhase("A");
    return rows;
  } finally {
    await client.end();
  }
}

// --- Phase B ---
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

function gatherContext(persons, gmailIndex) {
  if (!fs.existsSync(WACLI_DB)) throw new Error(`wacli.db missing at ${WACLI_DB}`);
  const db = new Database(WACLI_DB, { readonly: true });

  const dmMessagesStmt = db.prepare(`
    SELECT chat_name, sender_name, ts, from_me, COALESCE(text, display_text, media_caption, '') AS body, media_type
    FROM messages WHERE chat_jid = ? ORDER BY ts DESC LIMIT 30
  `);
  const groupsForJidStmt = db.prepare(`
    SELECT g.name AS group_name FROM group_participants gp
    JOIN groups g ON g.jid = gp.group_jid
    WHERE gp.user_jid = ? LIMIT 20
  `);
  const groupMessagesByJidStmt = db.prepare(`
    SELECT m.chat_name, m.sender_name, m.ts,
           COALESCE(m.text, m.display_text, m.media_caption, '') AS body
    FROM messages m JOIN chats c ON c.jid = m.chat_jid
    WHERE c.kind = 'group' AND m.sender_jid = ?
    ORDER BY m.ts DESC LIMIT 10
  `);
  const contactStmt = db.prepare(`
    SELECT push_name, full_name, business_name FROM contacts WHERE jid = ? LIMIT 1
  `);

  const out = [];
  for (const p of persons) {
    const ctx = {
      person_id: p.person_id, name: p.name,
      phones: p.phones, emails: p.emails,
      wa_messages: [], wa_groups: [], wa_group_messages: [],
      wa_contact_meta: null, gmail_threads: [],
    };
    for (const phone of p.phones) {
      const digits = String(phone).replace(/\D+/g, "");
      if (!digits) continue;
      const dmJid = `${digits}@s.whatsapp.net`;

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
      const groups = groupsForJidStmt.all(dmJid);
      for (const g of groups) if (g.group_name) ctx.wa_groups.push(g.group_name);
      const gmsgs = groupMessagesByJidStmt.all(dmJid);
      for (const m of gmsgs) {
        ctx.wa_group_messages.push({
          group: m.chat_name, ts: m.ts, body: (m.body || "").slice(0, 200),
        });
      }
    }
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
    ctx.wa_groups = [...new Set(ctx.wa_groups)].slice(0, 20);
    ctx.wa_messages = ctx.wa_messages.slice(0, 30);
    ctx.wa_group_messages = ctx.wa_group_messages.slice(0, 10);
    ctx.gmail_threads = ctx.gmail_threads.slice(0, 5);
    out.push(ctx);
  }
  db.close();
  return out;
}

async function phaseB(persons) {
  startPhase("B");
  const gmailIndex = loadGmailIndex();
  const ctxs = gatherContext(persons, gmailIndex);
  const outPath = path.join(OUT_DIR, "contexts.ndjson");
  fs.writeFileSync(outPath, ctxs.map((c) => JSON.stringify(c)).join("\n") + "\n");
  let withWA = 0, withGmail = 0, withGroups = 0, empty = 0;
  for (const c of ctxs) {
    if (c.wa_messages.length) withWA++;
    if (c.gmail_threads.length) withGmail++;
    if (c.wa_groups.length) withGroups++;
    if (!c.wa_messages.length && !c.gmail_threads.length && !c.wa_groups.length) empty++;
  }
  console.error(`[${elapsed()}] Phase B: ctx=${ctxs.length} WA=${withWA} Gmail=${withGmail} Groups=${withGroups} empty=${empty}`);
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

Output format: a single JSON object {"results": [<one object per input person, in the same order>]}.`;

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
  const obsPath = path.join(OUT_DIR, "enriched-observations.ndjson");
  const out = [];
  const observedAt = new Date().toISOString();
  const validCategories = new Set(["investor","team","sponsor","fellow","media","community","founder","friend","press","other"]);

  for (const c of contexts) {
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
      evidence_pointer: `enrichment://stage-6-v3-2026-04-20/person-${c.person_id}`,
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
    const body = JSON.stringify({ observations: chunks[i] });
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

async function phaseE(contexts, enrichedById) {
  startPhase("E");
  const apiUrl = process.env.ORBIT_API_URL;
  if (!apiUrl) {
    console.error(`[${elapsed()}] Phase E: ORBIT_API_URL missing — skipping`);
    endPhase("E");
    return { audit: [], canary: { ok: true, note: "skipped" } };
  }
  const enrichedIds = [...enrichedById.keys()];
  const sampled = [];
  for (let i = 0; i < Math.min(10, enrichedIds.length); i++) {
    const idx = Math.floor(Math.random() * enrichedIds.length);
    sampled.push(enrichedIds.splice(idx, 1)[0]);
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
    const fresh = await fetchCard("67050b91-5011-4ba6-b230-9a387879717a");
    if (fresh?.error) {
      canary = { ok: false, error: fresh.error };
    } else {
      const stableKeys = ["name", "company", "title", "category", "phones", "emails", "relationship_to_me"];
      const a = {}, b = {};
      for (const k of stableKeys) { a[k] = baseline?.card?.[k]; b[k] = fresh?.card?.[k]; }
      const ch = diff(a, b);
      canary = { ok: ch.length === 0, diff: ch };
    }
  } else {
    canary = { ok: true, note: "baseline missing — skipping canary" };
  }
  console.error(`[${elapsed()}] Phase E: audit=${audit.length}, canary=${canary.ok ? "PASS" : "FAIL"}`);
  endPhase("E");
  return { audit, canary };
}

// --- Report ---
function writeReport(meta) {
  const reportPath = path.join(OUT_DIR, "report.md");
  const summaryPath = path.join(OUT_DIR, "summary.json");
  const timingsPath = path.join(OUT_DIR, "phase-timings.json");
  fs.writeFileSync(timingsPath, JSON.stringify(phaseTimings, null, 2));
  fs.writeFileSync(summaryPath, JSON.stringify(meta, null, 2));

  const auditTable = (meta.audit ?? []).map((a) =>
    `| ${a.person_id.slice(0, 8)} | ${a.card_category ?? "-"} | ${(a.card_relationship ?? "").slice(0, 80).replace(/\|/g, "\\|")} | ${a.card_company ?? "-"} | ${a.card_title ?? "-"} |`
  ).join("\n");

  const md = `# Stage 6 V3 — Enrichment Report

**Verdict:** \`${meta.verdict}\`
**Run started:** ${new Date(t0).toISOString()}
**Wall-clock:** ${((Date.now() - t0) / 1000).toFixed(1)}s

## Phase timings
${Object.entries(phaseTimings).map(([k, v]) => `- Phase ${k}: ${(v.ms / 1000).toFixed(1)}s`).join("\n")}

## Inputs / outputs
- Skeleton persons: ${meta.skeletonCount}
- Enriched: ${meta.enrichedCount}
- Failed LLM batches: ${meta.failedBatchCount}
- Observations written: ${meta.obsWritten}
- Observations inserted: ${meta.inserted}
- Observations deduped: ${meta.deduped}
- POST failed batches: ${meta.postFailedBatches}

## Token usage
- Input tokens: ${meta.tokens.input_tokens.toLocaleString()}
- Output tokens: ${meta.tokens.output_tokens.toLocaleString()}
- Cache write tokens: ${meta.tokens.cache_creation_input_tokens.toLocaleString()}
- Cache read tokens: ${meta.tokens.cache_read_input_tokens.toLocaleString()}
- **Estimated cost: $${meta.cost.toFixed(3)}**

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

  const persons = await phaseA();
  const contexts = await phaseB(persons);
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
    for (const e of checkSample) {
      const rel = (e.relationship_to_me ?? "").toLowerCase();
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

  const e = await phaseE(contexts, c.enrichedById);

  let verdict;
  if (c.aborted) verdict = `STAGE6_V3_HALT: ${c.abortReason}`;
  else if (!proceedToD) verdict = "STAGE6_V3_PARTIAL: quality gate failed — no DB writes";
  else if (postResult.failed_batches.length > 0 || c.failedBatches.length > 0) {
    verdict = `STAGE6_V3_PARTIAL: ${c.failedBatches.length} LLM batches failed, ${postResult.failed_batches.length} POST batches failed`;
  } else if (!e.canary.ok) verdict = "STAGE6_V3_PARTIAL: Umayr canary regressed";
  else verdict = "STAGE6_V3_PASS";

  writeReport({
    verdict,
    skeletonCount: persons.length,
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
    notes,
  });

  console.error(`\n=== ${verdict} ===\n`);
}

main().catch((err) => {
  console.error(`FATAL: ${err.stack || err.message}`);
  try {
    writeReport({
      verdict: `STAGE6_V3_HALT: ${err.message}`,
      skeletonCount: 0, enrichedCount: 0, failedBatchCount: 0,
      obsWritten: 0, inserted: 0, deduped: 0, postFailedBatches: 0,
      tokens: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      cost: 0, audit: [], canary: { ok: false, error: "halted before audit" },
      notes: [`Fatal: ${err.stack || err.message}`],
    });
  } catch {}
  process.exit(1);
});
