#!/usr/bin/env node
// manifest-gen.mjs — Build one NDJSON line per resolved human from claw's
// wacli.db + session.db + Gmail export + Google Contacts export.
//
// Inline copies of the orbit-rules logic (phone.mjs, email.mjs, domain.mjs,
// lid.mjs) so this is a hypothesis test, not a production change. Runs on
// claw where node_modules (libphonenumber-js, better-sqlite3) live inside
// ~/.openclaw/plugins/orbit-rules/. Deploy path:
//   ~/.openclaw/plugins/orbit-rules/manifest-gen.mjs
//
// Deterministic: no wall-clock timestamps in output. Runs twice in a row
// should produce byte-identical files (first_seen/last_seen are
// source-driven, bucket order is canonical).

import Database from "better-sqlite3";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { parsePhoneNumberFromString } from "libphonenumber-js";

// ----- paths -----
const HOME = os.homedir();
const WACLI_DB = path.join(HOME, ".wacli", "wacli.db");
const SESSION_DB = path.join(HOME, ".wacli", "session.db");
const GMAIL_NDJSON = path.join(HOME, ".orbit-export", "gmail-wide-20260418.messages.ndjson");
const GCONTACTS_JSON = path.join(HOME, ".orbit-export", "google-contacts-20260418.ndjson");
const OUT_PATH = process.env.OUT_PATH || "/tmp/orbit-manifest-2026-04-19.ndjson";

// Owner identities to exclude. Sourced from env so the same script runs
// per-founder on claw. CSV-separated; trimmed + normalized.
//   ORBIT_SELF_EMAIL=a@b.com,c@d.com
//   ORBIT_SELF_PHONE=+1234567,+9112345
// SELF_NAME_HINTS stays hardcoded — phonetic/name hints are harder to
// parameterize cleanly (per plan §5 D6, deferred to multi-tenant work).
const SELF_EMAILS = new Set(
  (process.env.ORBIT_SELF_EMAIL || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);
const SELF_PHONES = new Set(
  (process.env.ORBIT_SELF_PHONE || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
if (SELF_EMAILS.size === 0) {
  console.error(
    "[manifest-gen] refusing to run: ORBIT_SELF_EMAIL is unset — cannot identify owner rows to exclude",
  );
  process.exit(2);
}
const SELF_NAME_HINTS = ["sanchay thalnerkar", "sanchay"];

// ----- rules: phone -----
function normalizePhone(raw, defaultCountry = "IN") {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim();
  s = s.replace(/@s\.whatsapp\.net$/i, "");
  s = s.replace(/@lid$/i, "");
  s = s.replace(/@g\.us$/i, "");
  let parsed = null;
  if (/^\d{11,15}$/.test(s)) {
    parsed = parsePhoneNumberFromString("+" + s);
  }
  if (!parsed || !parsed.isValid()) {
    parsed = parsePhoneNumberFromString(s, defaultCountry);
  }
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number;
}

// ----- rules: email -----
const GMAIL_FAMILY = new Set(["gmail.com", "googlemail.com"]);
const EMAIL_RE = /^([^\s@]+)@([a-z0-9][a-z0-9.-]*\.[a-z]{2,})$/i;
function canonicalizeEmail(raw) {
  if (!raw || typeof raw !== "string") return null;
  const lowered = raw.trim().toLowerCase();
  const m = lowered.match(EMAIL_RE);
  if (!m) return null;
  let [, local, domain] = m;
  const plus = local.indexOf("+");
  if (plus >= 0) local = local.slice(0, plus);
  if (GMAIL_FAMILY.has(domain)) {
    local = local.replace(/\./g, "");
    domain = "gmail.com";
  }
  if (!local) return null;
  return `${local}@${domain}`;
}
function emailDomain(canonical) {
  if (!canonical) return null;
  const at = canonical.indexOf("@");
  return at < 0 ? null : canonical.slice(at + 1);
}

// ----- rules: domain class (inline from orbit-rules/data/domains.json) -----
// Fix #1: extended bot-localpart regex — added account-info, accounts, receipts,
// billing-info, statements, invoices, bounces, notify, mailer.
const BOT_DOMAINS = new Set([
  "noreply.github.com",
  "no-reply.com",
  "notifications.github.com",
  "notifications.stripe.com",
  "notifications.slack.com",
  "notifications.linear.app",
  "alerts.hdfcbank.bank.in",
  "alerts.icicibank.com",
  "mail.cyphersol.co.in",
]);
const BOT_LOCALPART_RE = /^(noreply|no-reply|do-not-reply|donotreply|mailer-daemon|mailer|notify|notifications?|alerts?|support|billing|billing-?info|hello|help|security|updates?|digest|newsletter|info|team|account-?info|accounts?|receipts?|statements?|invoices?|bounces?)$/i;
// Contains-patterns for compound bot localparts like
// "googleone-out-of-quota-noreply@google.com" or "cs-support-team@x.com".
const BOT_LOCALPART_CONTAINS_RE = /(^|[-_.])(noreply|no-reply|donotreply|do-not-reply|mailer-daemon|notifications?|alerts?|bounces?|mailer)(\b|[-_.]|$)/i;
function isBotEmail(canonical) {
  if (!canonical) return false;
  const [local, domain] = canonical.split("@");
  if (BOT_DOMAINS.has(domain)) return true;
  if (BOT_LOCALPART_RE.test(local)) return true;
  if (BOT_LOCALPART_CONTAINS_RE.test(local)) return true;
  // Sub-domain based bot signals (mail.foo.com, alerts.foo.com, noreply.foo.com)
  if (/^(noreply|no-reply|alerts|notifications|mail|bounces|mailer|email)\./i.test(domain)) return true;
  return false;
}

// ----- Fix #2: forwarded-chain name stripping -----
// Gmail's "From" header on forwarded mail sometimes keeps the ORIGINAL
// sender's display name ("DigitalOcean") while the technical address
// belongs to the forwarder (shamlata@cyphersol.co.in). Detect this by
// checking whether the name matches a well-known SaaS vendor AND the
// domain is NOT that vendor's.
const SAAS_VENDOR_NAMES = new Set([
  "digitalocean", "digital ocean", "stripe", "aws", "amazon", "amazon web services",
  "notion", "linear", "gumroad", "booking.com", "airbnb", "cloudflare",
  "microsoft", "google", "meta", "openai", "anthropic", "github", "gitlab",
  "vercel", "supabase", "figma", "slack", "zoom", "hubspot", "salesforce",
  "mailchimp", "intercom", "zendesk", "shopify", "calendly", "docusign",
  "dropbox", "atlassian", "jira", "confluence", "asana", "trello",
  "quickbooks", "xero", "razorpay", "paypal", "apple",
]);
const SAAS_VENDOR_DOMAINS = {
  "digitalocean": ["digitalocean.com"],
  "digital ocean": ["digitalocean.com"],
  "stripe": ["stripe.com"],
  "aws": ["amazon.com", "aws.amazon.com"],
  "amazon": ["amazon.com", "amazon.in", "amazon.co.uk"],
  "amazon web services": ["amazon.com", "aws.amazon.com"],
  "notion": ["notion.so", "notion.com", "makenotion.com"],
  "linear": ["linear.app"],
  "gumroad": ["gumroad.com"],
  "booking.com": ["booking.com"],
  "airbnb": ["airbnb.com"],
  "cloudflare": ["cloudflare.com"],
  "microsoft": ["microsoft.com", "outlook.com", "live.com"],
  "google": ["google.com", "gmail.com"],
  "meta": ["meta.com", "facebook.com", "fb.com"],
  "openai": ["openai.com"],
  "anthropic": ["anthropic.com"],
  "github": ["github.com"],
  "gitlab": ["gitlab.com"],
  "vercel": ["vercel.com"],
  "supabase": ["supabase.io", "supabase.co", "supabase.com"],
  "figma": ["figma.com"],
  "slack": ["slack.com"],
  "zoom": ["zoom.us"],
  "hubspot": ["hubspot.com"],
  "salesforce": ["salesforce.com"],
  "mailchimp": ["mailchimp.com"],
  "intercom": ["intercom.com"],
  "zendesk": ["zendesk.com"],
  "shopify": ["shopify.com"],
  "calendly": ["calendly.com"],
  "docusign": ["docusign.com"],
  "dropbox": ["dropbox.com"],
  "atlassian": ["atlassian.com", "atlassian.net"],
  "jira": ["atlassian.com", "atlassian.net"],
  "confluence": ["atlassian.com", "atlassian.net"],
  "asana": ["asana.com"],
  "trello": ["trello.com"],
  "quickbooks": ["intuit.com", "quickbooks.com"],
  "xero": ["xero.com"],
  "razorpay": ["razorpay.com"],
  "paypal": ["paypal.com"],
  "apple": ["apple.com", "icloud.com", "me.com", "mac.com"],
};
function stripForwardedChainName(fromName, fromEmail) {
  if (fromName === null || fromName === undefined) return null;
  if (typeof fromName !== "string") return null;
  let name = fromName.trim();
  if (!name) return null;
  if (/^<.*>$/.test(name)) return null;
  // strip "X via Y", "X on behalf of Y", etc.
  const wrap = name.match(/^(.+?)\s+(?:via|on behalf of|through|for)\s+.+$/i);
  if (wrap) name = wrap[1].trim();
  if (!name) return null;
  // strip trailing "(Vendor)"
  const parenMatch = name.match(/\(([^)]+)\)/);
  if (parenMatch) {
    const inside = parenMatch[1].trim().toLowerCase();
    if (SAAS_VENDOR_NAMES.has(inside)) {
      name = name.replace(/\s*\([^)]+\)\s*$/, "").trim();
    }
  }
  if (!name) return null;
  const nname = name.trim().toLowerCase().replace(/\s+/g, " ");
  if (SAAS_VENDOR_NAMES.has(nname)) {
    const domain = (fromEmail || "").split("@").pop()?.toLowerCase() || "";
    const keys = [nname];
    const compact = nname.replace(/\s+/g, "");
    if (compact !== nname && SAAS_VENDOR_NAMES.has(compact)) keys.push(compact);
    let matched = false;
    for (const k of keys) {
      const entries = SAAS_VENDOR_DOMAINS[k] || [];
      for (const vd of entries) {
        if (domain === vd || domain.endsWith("." + vd)) { matched = true; break; }
      }
      if (matched) break;
    }
    if (!matched) return null;
  }
  return name;
}

// ----- Fix #3: Layer 2 cross-channel fuzzy-name bridge -----
const GENERIC_FIRST_NAMES = new Set([
  "john","mike","dave","bob","ram","raj","tom","sam","alex","chris","pat",
  "max","jay","ken","lee","amy","ann","kim","meg","joe","sue","don","ben",
  "dan","ed","al","jim","ron","tim",
]);
function normalizeFuzzyName(s) {
  return (s ?? "").toString().normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function tokensOf(s) { return normalizeFuzzyName(s).split(" ").filter(Boolean); }
function jaroWinkler(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatches = new Array(a.length).fill(false);
  const bMatches = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - matchWindow);
    const hi = Math.min(b.length - 1, i + matchWindow);
    for (let j = lo; j <= hi; j++) {
      if (bMatches[j]) continue;
      if (a[i] !== b[j]) continue;
      aMatches[i] = true; bMatches[j] = true; matches++; break;
    }
  }
  if (!matches) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions/2) / matches) / 3;
  let prefix = 0;
  const limit = Math.min(4, a.length, b.length);
  for (let i = 0; i < limit; i++) { if (a[i] === b[i]) prefix++; else break; }
  return jaro + prefix * 0.1 * (1 - jaro);
}
function tokenSetSort(a, b) {
  const ta = new Set(a.split(" ").filter(Boolean));
  const tb = new Set(b.split(" ").filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  const inter = new Set([...ta].filter(x => tb.has(x)));
  const onlyA = [...ta].filter(x => !tb.has(x)).sort();
  const onlyB = [...tb].filter(x => !ta.has(x)).sort();
  const interS = [...inter].sort();
  const s1 = interS.join(" ");
  const s2 = [...interS, ...onlyA].join(" ");
  const s3 = [...interS, ...onlyB].join(" ");
  return Math.max(jaroWinkler(s1, s2), jaroWinkler(s1, s3), jaroWinkler(s2, s3));
}
function fuzzyScore(a, b) {
  const na = normalizeFuzzyName(a);
  const nb = normalizeFuzzyName(b);
  if (!na || !nb) return 0;
  const jw = jaroWinkler(na, nb);
  const ts = tokenSetSort(na, nb);
  return Math.max(jw, ts);
}
function isGenericName(name) {
  const toks = tokensOf(name);
  if (!toks.length) return true;
  if (toks.length === 1) {
    const t = toks[0];
    if (t.length < 4) return true;
    if (GENERIC_FIRST_NAMES.has(t)) return true;
    if (SAAS_VENDOR_NAMES.has(t)) return true;
  }
  const full = normalizeFuzzyName(name);
  if (SAAS_VENDOR_NAMES.has(full)) return true;
  // Any token in a short (<=2-token) name being a vendor → block (catches
  // "Amazon.in" → tokens "amazon","in", and "Google Inc", etc.)
  if (toks.length <= 2) {
    for (const t of toks) if (SAAS_VENDOR_NAMES.has(t)) return true;
  }
  return false;
}

// ----- rules: lid -> phone from session.db -----
function buildLidMap() {
  if (!existsSync(SESSION_DB)) return new Map();
  const db = new Database(SESSION_DB, { readonly: true });
  try {
    const rows = db.prepare("SELECT lid, pn FROM whatsmeow_lid_map").all();
    const map = new Map();
    for (const r of rows) {
      if (!r.lid || !r.pn) continue;
      const pn = String(r.pn).trim();
      const e164 = pn.startsWith("+") ? pn : `+${pn}`;
      map.set(String(r.lid), e164);
    }
    return map;
  } finally {
    db.close();
  }
}

// ----- header parsing helpers -----
function parseAddressList(raw) {
  // Parse a raw RFC-5322 address list into [{name, email}].
  // Handles: "Name <email>", "email", with commas separating.
  if (!raw) return [];
  const out = [];
  // Split top-level by commas that are not inside quotes
  const parts = [];
  let buf = "";
  let inQ = false;
  for (const ch of raw) {
    if (ch === '"') inQ = !inQ;
    if (ch === "," && !inQ) {
      parts.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) parts.push(buf);
  const angle = /^\s*("?)(.*?)\1\s*<([^>]+)>\s*$/;
  const bare = /^\s*([^\s<>@]+@[^\s<>@]+)\s*$/;
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    const m1 = t.match(angle);
    if (m1) {
      const name = (m1[2] || "").trim().replace(/^"|"$/g, "").trim();
      const email = m1[3].trim();
      out.push({ name: name || null, email });
      continue;
    }
    const m2 = t.match(bare);
    if (m2) {
      out.push({ name: null, email: m2[1] });
      continue;
    }
    // fallback: might contain an email anywhere
    const m3 = t.match(/([^\s<>@]+@[^\s<>@]+)/);
    if (m3) out.push({ name: t.replace(m3[1], "").trim().replace(/^"|"$/g, "") || null, email: m3[1] });
  }
  return out;
}

function headerMap(headers) {
  const m = {};
  for (const h of headers || []) {
    m[(h.name || "").toLowerCase()] = h.value;
  }
  return m;
}

// ----- union-find -----
class DSU {
  constructor() {
    this.parent = new Map();
    this.rank = new Map();
  }
  make(x) {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
    }
  }
  find(x) {
    this.make(x);
    let p = this.parent.get(x);
    if (p === x) return x;
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return ra;
    const rka = this.rank.get(ra);
    const rkb = this.rank.get(rb);
    let root;
    if (rka < rkb) {
      this.parent.set(ra, rb);
      root = rb;
    } else if (rka > rkb) {
      this.parent.set(rb, ra);
      root = ra;
    } else {
      this.parent.set(rb, ra);
      this.rank.set(ra, rka + 1);
      root = ra;
    }
    return root;
  }
}

// ----- deterministic short-id: sha1 of root key, first 12 hex -----
function shortId(rootKey) {
  return "local-" + createHash("sha1").update(rootKey).digest("hex").slice(0, 12);
}

// ----- enrichment merge -----
// If ORBIT_API_URL + ORBIT_API_KEY are set, fetch the enriched-persons
// list once at start; build a lookup by phone + lowered-email. During
// bucket emission, if a bucket's phone/email matches an enriched row,
// the DB wins on {category, relationship_to_me, company, title, name-if-longer};
// the manifest wins on {last_seen, first_seen, thread_count, groups, source_provenance}.
//
// Standalone-safe: if env missing OR fetch fails, returns empty index —
// manifest-gen still runs fully.
async function fetchEnrichedIndex() {
  const base = process.env.ORBIT_API_URL;
  const key = process.env.ORBIT_API_KEY;
  if (!base || !key) {
    console.error(
      "[manifest-gen] enrichment merge skipped: ORBIT_API_URL/ORBIT_API_KEY not set",
    );
    return { byPhone: new Map(), byEmail: new Map() };
  }
  const byPhone = new Map();
  const byEmail = new Map();
  let cursor = null;
  let pages = 0;
  const MAX_PAGES = 10;
  try {
    while (pages < MAX_PAGES) {
      const u = new URL(base.replace(/\/+$/, "") + "/persons/enriched");
      u.searchParams.set("limit", "500");
      if (cursor) u.searchParams.set("cursor", cursor);
      const res = await fetch(u.toString(), {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok) {
        console.error(
          `[manifest-gen] enrichment fetch failed HTTP ${res.status}; proceeding without merge`,
        );
        return { byPhone: new Map(), byEmail: new Map() };
      }
      const body = await res.json();
      for (const p of body.persons ?? []) {
        const rec = {
          category: p.category ?? null,
          relationship_to_me: p.relationship_to_me ?? "",
          company: p.company ?? null,
          title: p.title ?? null,
          name: p.name ?? null,
        };
        for (const ph of p.phones ?? []) {
          if (ph) byPhone.set(String(ph), rec);
        }
        for (const em of p.emails ?? []) {
          if (em) byEmail.set(String(em).toLowerCase(), rec);
        }
      }
      if (!body.next_cursor) break;
      cursor = body.next_cursor;
      pages += 1;
    }
  } catch (e) {
    console.error(
      `[manifest-gen] enrichment fetch threw: ${e?.message ?? e}; proceeding without merge`,
    );
    return { byPhone: new Map(), byEmail: new Map() };
  }
  console.error(
    `[manifest-gen] enrichment index: ${byPhone.size} phones + ${byEmail.size} emails`,
  );
  return { byPhone, byEmail };
}

function lookupEnriched(bucket, idx) {
  for (const ph of bucket.phones ?? []) {
    const hit = idx.byPhone.get(ph);
    if (hit) return hit;
  }
  for (const em of bucket.emails ?? []) {
    const hit = idx.byEmail.get(String(em).toLowerCase());
    if (hit) return hit;
  }
  return null;
}

function mergeEnriched(bucket, enriched) {
  if (!enriched) return bucket;
  // DB wins on enrichment-y fields. Name only wins if DB's is strictly longer.
  const out = { ...bucket };
  if (enriched.category) out.category = enriched.category;
  if (typeof enriched.relationship_to_me === "string" && enriched.relationship_to_me.length > 0) {
    out.relationship_to_me = enriched.relationship_to_me;
  }
  if (enriched.company) out.company = enriched.company;
  if (enriched.title) out.title = enriched.title;
  if (
    enriched.name &&
    (!bucket.name || enriched.name.length > bucket.name.length)
  ) {
    out.name = enriched.name;
  }
  return out;
}

// ----- main build -----
async function build() {
  console.error("[manifest-gen] loading...");
  const enrichmentIdx = await fetchEnrichedIndex();
  const lidMap = buildLidMap();
  console.error(`[manifest-gen] lid_map rows: ${lidMap.size}`);

  // A "node" is a canonical identity token: "phone:+971...", "email:foo@bar.com", "lid:123456"
  // Each observation contributes: nodes (for union-find), + per-node metadata.
  // We also track the node that owns a given source-provenance flag, name candidate, timestamps, threads.
  const dsu = new DSU();
  const meta = new Map(); // node -> { names: [{source, name}], times: [iso], groups: Set, provenance: Set, threads: Set (qualified) }
  const crossChannelMerges = new Set(); // DSU roots whose existence is due to Layer-2 fuzzy-name bridge

  function ensureMeta(node) {
    if (!meta.has(node)) {
      meta.set(node, {
        names: [],
        times: [],
        groups: new Set(),
        provenance: new Set(),
        threads: new Set(),
      });
    }
    return meta.get(node);
  }
  function addObs(nodes, { name, nameSource, ts, group, provenance, thread } = {}) {
    if (!nodes || !nodes.length) return;
    // union all nodes
    nodes.forEach((n) => dsu.make(n));
    for (let i = 1; i < nodes.length; i++) dsu.union(nodes[0], nodes[i]);
    // attach metadata to each node
    for (const n of nodes) {
      const m = ensureMeta(n);
      if (name) m.names.push({ source: nameSource || "unknown", name });
      if (ts) m.times.push(ts);
      if (group) m.groups.add(group);
      if (provenance) m.provenance.add(provenance);
      if (thread) m.threads.add(thread);
    }
  }

  // ----- 1. wacli contacts -----
  const wacli = new Database(WACLI_DB, { readonly: true });
  try {
    const contactsRows = wacli
      .prepare("SELECT jid, phone, push_name, full_name, first_name FROM contacts")
      .all();
    console.error(`[manifest-gen] wacli contacts: ${contactsRows.length}`);
    let droppedGhost = 0;
    let kept = 0;
    for (const c of contactsRows) {
      const jid = String(c.jid || "");
      const fullName = (c.full_name || "").trim() || null;
      const pushName = (c.push_name || "").trim() || null;
      const firstName = (c.first_name || "").trim() || null;
      const bestName = fullName || pushName || firstName || null;

      if (jid.endsWith("@lid")) {
        // Fix #1: for @lid, session.db is ONLY valid phone source. Ignore contacts.phone.
        const bare = jid.slice(0, -4);
        const bridged = lidMap.get(bare) || null;
        // Fix #2: drop nameless @lid with no bridge AND no name
        if (!bridged && !bestName) {
          droppedGhost++;
          continue;
        }
        const nodes = [];
        nodes.push(`lid:${bare}`);
        if (bridged) nodes.push(`phone:${bridged}`);
        addObs(nodes, {
          name: bestName,
          nameSource: "wa_contact",
          provenance: "wa_contact",
        });
        kept++;
      } else if (jid.endsWith("@s.whatsapp.net")) {
        const raw = jid.slice(0, -"@s.whatsapp.net".length);
        const e164 = normalizePhone(raw);
        if (!e164) continue;
        addObs([`phone:${e164}`], {
          name: bestName,
          nameSource: "wa_contact",
          provenance: "wa_contact",
        });
        kept++;
      } else {
        // jid like group @g.us in contacts: skip
        continue;
      }
    }
    console.error(`[manifest-gen] wacli contacts kept: ${kept} dropped_ghost: ${droppedGhost}`);
  } finally {
    // keep wacli open until after messages scan
  }

  // ----- 2. wacli messages: DM threads + group membership -----
  // DM: one thread per chat_jid where chat_jid like %@s.whatsapp.net. Counterpart = the phone.
  // Group: one thread per group + one participant observation per distinct sender_jid in that group.
  try {
    // Preload chats names
    // Prefer groups.name over chats.name for group chats — wacli's chats.name
    // is sometimes polluted with a contact push_name for group rows. groups.name
    // is the canonical WhatsApp group subject.
    const chatRows = wacli
      .prepare(
        `SELECT c.jid, c.kind,
                CASE WHEN c.kind = 'group' THEN COALESCE(g.name, c.name)
                     ELSE c.name END AS name
         FROM chats c
         LEFT JOIN groups g ON c.jid = g.jid`
      )
      .all();
    const chatKind = new Map();
    const chatName = new Map();
    for (const r of chatRows) {
      chatKind.set(r.jid, r.kind);
      chatName.set(r.jid, r.name);
    }

    // DM observations
    const dmStmt = wacli.prepare(
      "SELECT chat_jid, MIN(ts) AS first_ts, MAX(ts) AS last_ts FROM messages WHERE chat_jid LIKE '%@s.whatsapp.net' GROUP BY chat_jid"
    );
    const dmRows = dmStmt.all();
    let dmKept = 0;
    for (const r of dmRows) {
      const raw = r.chat_jid.slice(0, -"@s.whatsapp.net".length);
      const e164 = normalizePhone(raw);
      if (!e164) continue;
      const first = new Date(r.first_ts * 1000).toISOString();
      const last = new Date(r.last_ts * 1000).toISOString();
      addObs([`phone:${e164}`], {
        ts: first,
        provenance: "wa_dm",
        thread: `wa_dm:${r.chat_jid}`,
      });
      addObs([`phone:${e164}`], { ts: last });
      dmKept++;
    }
    console.error(`[manifest-gen] wa DMs tracked: ${dmKept}`);

    // Group participants: iterate group messages, track per-group distinct senders + their name/ts.
    const gStmt = wacli.prepare(`
      SELECT chat_jid, sender_jid, sender_name, MIN(ts) AS first_ts, MAX(ts) AS last_ts
      FROM messages
      WHERE chat_jid LIKE '%@g.us' AND from_me = 0 AND sender_jid IS NOT NULL
      GROUP BY chat_jid, sender_jid
    `);
    const gRows = gStmt.all();
    let gKept = 0;
    for (const r of gRows) {
      const senderJid = String(r.sender_jid);
      const grpName = chatName.get(r.chat_jid) || r.chat_jid;
      const first = new Date(r.first_ts * 1000).toISOString();
      const last = new Date(r.last_ts * 1000).toISOString();
      const nameCand = (r.sender_name || "").trim() || null;

      let nodes = [];
      if (senderJid.endsWith("@s.whatsapp.net")) {
        const raw = senderJid.slice(0, -"@s.whatsapp.net".length);
        const e164 = normalizePhone(raw);
        if (!e164) continue;
        nodes = [`phone:${e164}`];
      } else if (senderJid.endsWith("@lid")) {
        const bare = senderJid.slice(0, -4);
        const bridged = lidMap.get(bare) || null;
        // Fix #2: drop if nameless AND no bridge
        if (!bridged && !nameCand) continue;
        nodes = [`lid:${bare}`];
        if (bridged) nodes.push(`phone:${bridged}`);
      } else {
        continue;
      }
      addObs(nodes, {
        name: nameCand,
        nameSource: "wa_group_sender",
        ts: first,
        group: grpName,
        provenance: "wa_group",
        thread: `wa_group:${r.chat_jid}:${senderJid}`,
      });
      addObs(nodes, { ts: last });
      gKept++;
    }
    console.error(`[manifest-gen] wa group participant rows: ${gKept}`);
  } finally {
    wacli.close();
  }

  // ----- 3. gmail messages -----
  // For each gmail message, parse From, To, Cc. Build per-thread participant set.
  // Each non-bot email participant gets an observation with thread=threadId.
  const gmailText = readFileSync(GMAIL_NDJSON, "utf8");
  const gmailLines = gmailText.split("\n").filter((l) => l.length);
  console.error(`[manifest-gen] gmail messages: ${gmailLines.length}`);

  let gmailFromBot = 0;
  let gmailKept = 0;
  for (const line of gmailLines) {
    let m;
    try {
      m = JSON.parse(line);
    } catch (e) {
      continue;
    }
    const headers = headerMap((m.payload || {}).headers || []);
    // Drop list-unsubscribe / bulk / List-Id headered messages
    if (headers["list-unsubscribe"] || /bulk/i.test(headers["precedence"] || "") || headers["list-id"]) {
      gmailFromBot++;
      continue;
    }
    const threadId = m.threadId || m.id;
    const internalDate = m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null;

    const fromParts = parseAddressList(headers["from"] || "");
    const toParts = parseAddressList(headers["to"] || "");
    const ccParts = parseAddressList(headers["cc"] || "");
    const all = [...fromParts, ...toParts, ...ccParts];

    const isFromBot = fromParts.some((p) => {
      const c = canonicalizeEmail(p.email);
      return !c || isBotEmail(c);
    });
    if (isFromBot) {
      gmailFromBot++;
      continue;
    }

    for (const p of all) {
      const c = canonicalizeEmail(p.email);
      if (!c) continue;
      // drop self
      if (SELF_EMAILS.has(c)) continue;
      if (isBotEmail(c)) continue;
      const fromFlag = fromParts.some((x) => canonicalizeEmail(x.email) === c);
      // Fix #2: strip forwarded-chain display-name pollution. Only applies
      // to gmail_from; gmail_to_cc display names are usually the recipient's
      // own name metadata and are trustworthy for that email.
      const rawName = p.name || null;
      const cleanedName = fromFlag
        ? stripForwardedChainName(rawName, p.email || c)
        : rawName;
      addObs([`email:${c}`], {
        name: cleanedName,
        nameSource: fromFlag ? "gmail_from" : "gmail_to_cc",
        ts: internalDate,
        provenance: fromFlag ? "gmail_from" : "gmail_to_cc",
        thread: `gmail:${threadId}`,
      });
    }
    gmailKept++;
  }
  console.error(`[manifest-gen] gmail kept: ${gmailKept} dropped_bulk_or_bot: ${gmailFromBot}`);

  // ----- 4. google contacts -----
  const gcRaw = readFileSync(GCONTACTS_JSON, "utf8");
  const gc = JSON.parse(gcRaw);
  const conns = gc.connections || [];
  console.error(`[manifest-gen] google contacts: ${conns.length}`);
  for (const c of conns) {
    const displayName =
      (c.names && c.names[0] && (c.names[0].displayName || c.names[0].unstructuredName)) || null;
    const phones = (c.phoneNumbers || [])
      .map((p) => normalizePhone(p.canonicalForm || p.value || ""))
      .filter(Boolean);
    const emails = (c.emailAddresses || [])
      .map((e) => canonicalizeEmail(e.value || ""))
      .filter(Boolean)
      .filter((e) => !SELF_EMAILS.has(e));
    const nodes = [];
    for (const p of phones) nodes.push(`phone:${p}`);
    for (const e of emails) nodes.push(`email:${e}`);
    if (!nodes.length) continue;
    addObs(nodes, {
      name: displayName,
      nameSource: "google_contact",
      provenance: "google_contact",
    });
  }

  // ----- 5. assemble buckets (preliminary — before Layer 2 bridge) -----
  function assembleBuckets() {
    const bkts = new Map();
    for (const node of meta.keys()) {
      const r = dsu.find(node);
      if (!bkts.has(r)) bkts.set(r, new Set());
      bkts.get(r).add(node);
    }
    return bkts;
  }

  function summarize(root, nodes) {
    const prov = new Set();
    const names = [];
    const phones = new Set();
    const emails = new Set();
    for (const n of nodes) {
      if (n.startsWith("phone:")) phones.add(n.slice(6));
      else if (n.startsWith("email:")) emails.add(n.slice(6));
      const mm = meta.get(n);
      if (!mm) continue;
      for (const p of mm.provenance) prov.add(p);
      for (const x of mm.names) names.push(x);
    }
    return {
      id: root,
      root,
      name: pickName(names),
      phones: Array.from(phones),
      emails: Array.from(emails),
      provenance: prov,
    };
  }

  let buckets = assembleBuckets();
  console.error(`[manifest-gen] buckets (pre-bridge): ${buckets.size}`);

  // ----- 5b. Fix #3: Layer 2 cross-channel fuzzy bridge -----
  // Scan WA-only ↔ Gmail-only bucket pairs. If names fuzzy-match above the
  // (guarded) threshold, union them in the DSU and reassemble.
  const summaries = Array.from(buckets.entries()).map(([root, nodes]) =>
    summarize(root, nodes),
  );
  // WA side = has at least one wa_* or google_contact signal, and NO gmail
  // signal. Google Contacts is phone-keyed in Sanchay's corpus, so buckets
  // that came in via Google Contacts + WA are still "WA side" for bridge
  // purposes. The Gmail side is the mirror: gmail signal, no wa/google_contact.
  function onlyWa(b) {
    const p = b.provenance;
    if (!p.size) return false;
    if (p.has("gmail_from") || p.has("gmail_to_cc")) return false;
    // must have at least one wa_* or google_contact signal
    return p.has("wa_dm") || p.has("wa_contact") || p.has("wa_group") || p.has("google_contact");
  }
  function onlyGmail(b) {
    const p = b.provenance;
    if (!p.size) return false;
    if (p.has("wa_dm") || p.has("wa_contact") || p.has("wa_group")) return false;
    if (p.has("google_contact")) return false;
    return p.has("gmail_from") || p.has("gmail_to_cc");
  }
  const waSides = summaries.filter(onlyWa).filter((b) => b.name);
  const gmailSides = summaries.filter(onlyGmail).filter((b) => b.name);
  let bridgeMerges = 0;
  const mergedRoots = new Set();
  for (const wa of waSides) {
    if (mergedRoots.has(wa.root)) continue;
    if (isGenericName(wa.name)) continue;
    let best = null;
    for (const gm of gmailSides) {
      if (mergedRoots.has(gm.root)) continue;
      if (isGenericName(gm.name)) continue;
      const score = fuzzyScore(wa.name, gm.name);
      const aTok = tokensOf(wa.name);
      const bTok = tokensOf(gm.name);
      const minTokens = Math.min(aTok.length, bTok.length);
      const cutoff = minTokens >= 2 ? 0.85 : 0.92;
      if (score < cutoff) continue;
      // multi-token guard: require >=2 shared tokens when both sides have 2+
      if (aTok.length >= 2 && bTok.length >= 2) {
        const aSet = new Set(aTok);
        let shared = 0;
        for (const t of bTok) if (aSet.has(t)) shared++;
        if (shared < 2) continue;
      }
      if (!best || score > best.score) best = { gm, score };
    }
    if (best) {
      dsu.union(wa.root, best.gm.root);
      mergedRoots.add(wa.root);
      mergedRoots.add(best.gm.root);
      bridgeMerges++;
      // Track which node-root pairs were merged so we can stamp
      // provenance on the emitted record later.
      crossChannelMerges.add(dsu.find(wa.root));
    }
  }
  console.error(`[manifest-gen] Layer 2 bridge merges: ${bridgeMerges}`);

  buckets = assembleBuckets();
  console.error(`[manifest-gen] buckets (post-bridge): ${buckets.size}`);

  // ----- 6. emit NDJSON with deterministic ordering -----
  const lines = [];
  // Sort bucket roots by canonical sorted-node-list for determinism
  const rootsSorted = Array.from(buckets.entries())
    .map(([root, nodes]) => ({ root, nodes: Array.from(nodes).sort() }))
    .sort((a, b) => (a.nodes[0] < b.nodes[0] ? -1 : a.nodes[0] > b.nodes[0] ? 1 : 0));

  let droppedSelf = 0;
  for (const { nodes } of rootsSorted) {
    const phones = new Set();
    const emails = new Set();
    const lids = new Set();
    const groups = new Set();
    const provenance = new Set();
    const threads = new Set();
    const nameCands = [];
    let firstSeen = null;
    let lastSeen = null;

    for (const n of nodes) {
      if (n.startsWith("phone:")) phones.add(n.slice(6));
      else if (n.startsWith("email:")) emails.add(n.slice(6));
      else if (n.startsWith("lid:")) lids.add(n.slice(4));
      const m = meta.get(n);
      if (!m) continue;
      for (const x of m.names) nameCands.push(x);
      for (const g of m.groups) groups.add(g);
      for (const p of m.provenance) provenance.add(p);
      for (const t of m.threads) threads.add(t);
      for (const ts of m.times) {
        if (!firstSeen || ts < firstSeen) firstSeen = ts;
        if (!lastSeen || ts > lastSeen) lastSeen = ts;
      }
    }

    // Drop the founder's own bucket
    const allEmails = Array.from(emails);
    if (allEmails.some((e) => SELF_EMAILS.has(e))) {
      droppedSelf++;
      continue;
    }
    const allPhones = Array.from(phones);
    if (allPhones.some((p) => SELF_PHONES.has(p))) {
      droppedSelf++;
      continue;
    }
    const mergedName = pickName(nameCands);
    if (mergedName && SELF_NAME_HINTS.includes(mergedName.toLowerCase())) {
      droppedSelf++;
      continue;
    }

    // Thread-count = distinct threads attached to any node in this bucket
    // split by source (wa_dm + wa_group + gmail threads). For wa_group, we
    // used per-(group,sender) as thread key; collapse to distinct groups.
    const waDmThreads = new Set();
    const waGroupThreads = new Set();
    const gmailThreads = new Set();
    for (const t of threads) {
      if (t.startsWith("wa_dm:")) waDmThreads.add(t);
      else if (t.startsWith("wa_group:")) {
        // "wa_group:<chat_jid>:<sender_jid>" -> the chat_jid part = the thread
        const parts = t.split(":");
        waGroupThreads.add(parts[1] || t);
      } else if (t.startsWith("gmail:")) gmailThreads.add(t);
    }
    const threadCount = waDmThreads.size + waGroupThreads.size + gmailThreads.size;

    const prov = {
      wa_dm: provenance.has("wa_dm"),
      wa_contact: provenance.has("wa_contact"),
      wa_group: provenance.has("wa_group"),
      gmail_from: provenance.has("gmail_from") || provenance.has("gmail_to_cc"),
      google_contact: provenance.has("google_contact"),
    };

    // Stamp cross-channel-merge provenance (Fix #3). The root we care about
    // is whichever node in this bucket DSU resolves to the same root as
    // the one we tagged during the bridge pass.
    let crossChannel = false;
    for (const n of nodes) {
      if (crossChannelMerges.has(dsu.find(n))) { crossChannel = true; break; }
    }
    if (crossChannel) prov.cross_channel_name_match = true;

    const rootKey = nodes[0];
    const id = shortId(rootKey);
    const rawBucket = {
      id,
      name: mergedName,
      phones: Array.from(phones).sort(),
      emails: Array.from(emails).sort(),
      lids: Array.from(lids).sort(),
      groups: Array.from(groups).sort(),
      first_seen: firstSeen,
      last_seen: lastSeen,
      thread_count: threadCount,
      source_provenance: prov,
    };
    // DB wins on enrichment; source wins on last_seen/thread_count/groups.
    const enriched = lookupEnriched(rawBucket, enrichmentIdx);
    const obj = mergeEnriched(rawBucket, enriched);
    lines.push(JSON.stringify(obj));
  }
  console.error(`[manifest-gen] dropped self buckets: ${droppedSelf}`);
  writeFileSync(OUT_PATH, lines.join("\n") + "\n", "utf8");
  console.error(`[manifest-gen] wrote ${lines.length} lines to ${OUT_PATH}`);
}

// ----- safety rules (mirrored from orbit-rules-plugin/lib/safety.mjs) -----
// These duplicate the plugin's checks because manifest-gen runs standalone on
// claw (where it can't resolve `../../orbit-rules-plugin/lib/` paths). Keep in
// sync with orbit-rules-plugin/lib/safety.mjs — the plugin is authoritative.
const SAFETY_PHONE_RE = /^\+?\d{6,}$/u;
const SAFETY_UNICODE_MASK_RE =
  /^\+?[\d\s.\-\u2022\u2219\u00B7\u30FB]{6,}$/u;
const SAFETY_UNICODE_MASK_CHAR_RE = /[\s.\-\u2022\u2219\u00B7\u30FB]/u;
const SAFETY_EMAIL_RE = /.+@.+/u;
const SAFETY_QUOTED_RE =
  /^['"\u2018\u201C\u0060].+['"\u2019\u201D\u0060]$/u;
const SAFETY_BOTS = new Set([
  "wazowski",
  "chad",
  "axe",
  "kite",
  "slackbot",
  "github-actions",
]);
const SAFETY_TEST_MARKERS = [
  /example\.com/i,
  /example\.org/i,
  /@test\.com/i,
  /\bapitest\./i,
];
function safetyDropReason({ name, emails = [], phones = [] }) {
  const n = typeof name === "string" ? name.trim() : "";
  if (!n) return "empty_name";
  if (SAFETY_PHONE_RE.test(n)) return "phone_as_name";
  if (SAFETY_UNICODE_MASK_CHAR_RE.test(n) && SAFETY_UNICODE_MASK_RE.test(n))
    return "unicode_masked_phone";
  if (SAFETY_EMAIL_RE.test(n)) return "email_as_name";
  if (n.length >= 2 && SAFETY_QUOTED_RE.test(n)) return "quoted_literal";
  if (SAFETY_BOTS.has(n.toLowerCase())) return "bot_name";
  const combined = [n, ...(emails || []), ...(phones || [])].filter(Boolean);
  for (const c of combined) {
    for (const re of SAFETY_TEST_MARKERS) if (re.test(String(c))) return "test_data_leak";
  }
  return null;
}

// ----- commercial-keyword classifier (mirrored from orbit-rules-plugin/lib/group-junk.mjs) -----
const COMMERCIAL_KW_RE =
  /\b(sale|sales|deal|deals|offer|offers|crypto|giveaway|giveaways|coupon|coupons|promo|promos|discount|discounts|airdrop|airdrops|signup bonus|referral|referrals)\b/i;
function classifyGroup({ member_count, self_outbound_count, sender_counts, group_name }) {
  const reasons = [];
  const mc = Number(member_count ?? 0);
  const so = Number(self_outbound_count ?? 0);
  if (mc > 200 && so === 0) reasons.push("mega_lurker");
  if (sender_counts && typeof sender_counts === "object") {
    const counts = Object.values(sender_counts).map(Number).filter((n) => Number.isFinite(n) && n > 0);
    const total = counts.reduce((a, b) => a + b, 0);
    if (total > 10) {
      const max = Math.max(...counts, 0);
      if (max / total > 0.8) reasons.push("broadcast_ratio");
    }
  }
  if (typeof group_name === "string" && COMMERCIAL_KW_RE.test(group_name))
    reasons.push("commercial_keyword");
  return { junk: reasons.length > 0, reasons };
}

// Name picker: ranks candidates via safetyDropReason + priority.
// Priority: wa_contact > google_contact > gmail_from > gmail_to_cc > wa_group_sender > wa_message_sender > unknown.
// Tie on priority: longer string wins.
function pickName(cands) {
  if (!cands || !cands.length) return null;
  const priority = {
    wa_contact: 1,
    google_contact: 2,
    gmail_from: 3,
    gmail_to_cc: 4,
    wa_group_sender: 5,
    wa_message_sender: 6,
    unknown: 7,
  };
  const filtered = cands.filter((c) => {
    if (!c?.name) return false;
    return safetyDropReason({ name: c.name }) === null;
  });
  if (!filtered.length) return null;
  filtered.sort((a, b) => {
    const pa = priority[a.source] ?? 9;
    const pb = priority[b.source] ?? 9;
    if (pa !== pb) return pa - pb;
    const la = (b.name || "").length - (a.name || "").length;
    if (la !== 0) return la;
    return (a.name || "").localeCompare(b.name || "");
  });
  return filtered[0].name.trim();
}

build().catch((e) => {
  console.error("[manifest-gen] fatal:", e?.message ?? e);
  process.exit(1);
});
