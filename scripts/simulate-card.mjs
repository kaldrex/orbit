import pg from "pg";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// Inline the assembleCard logic (JS port of card-assembler.ts).
function isSimilar(a, b, threshold = 0.5) {
  const tokenize = (s) =>
    new Set(
      String(s)
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 3),
    );
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const jaccard = shared / (ta.size + tb.size - shared);
  return jaccard >= threshold;
}

function assembleCard(personId, rows) {
  const sorted = [...rows].sort((a, b) => a.observed_at.localeCompare(b.observed_at));
  const phones = new Set();
  const emails = new Set();
  const interactions = [];
  const corrections = [];
  let name = null, company = null, title = null, category = null;
  let relationship_to_me = "";
  let last_touch = null;
  for (const row of sorted) {
    if (row.kind === "person") {
      const p = row.payload;
      if (p.name) name = p.name;
      if (p.company !== undefined && p.company !== null) company = p.company;
      if (p.title !== undefined && p.title !== null) title = p.title;
      if (p.category) category = p.category;
      if (p.relationship_to_me) relationship_to_me = p.relationship_to_me;
      for (const ph of p.phones ?? []) phones.add(ph);
      for (const em of p.emails ?? []) emails.add(em);
    } else if (row.kind === "interaction") {
      const p = row.payload;
      interactions.push({ id: row.id, observed_at: row.observed_at, kind: row.kind, evidence_pointer: row.evidence_pointer, confidence: Number(row.confidence), summary: p.summary });
      if (!last_touch || row.observed_at > last_touch) last_touch = row.observed_at;
    } else if (row.kind === "correction") {
      const p = row.payload;
      corrections.push({ id: row.id, observed_at: row.observed_at, kind: row.kind, evidence_pointer: row.evidence_pointer, confidence: Number(row.confidence), summary: `${p.field} -> ${JSON.stringify(p.new_value)}` });
      switch (p.field) {
        case "name": if (typeof p.new_value === "string") name = p.new_value; break;
        case "company": if (p.new_value === null || typeof p.new_value === "string") company = p.new_value; break;
        case "title": if (p.new_value === null || typeof p.new_value === "string") title = p.new_value; break;
        case "category": if (typeof p.new_value === "string") category = p.new_value; break;
        case "relationship_to_me": if (typeof p.new_value === "string") relationship_to_me = p.new_value; break;
        case "phones": if (Array.isArray(p.new_value)) { phones.clear(); for (const ph of p.new_value) if (typeof ph === "string") phones.add(ph); } break;
        case "emails": if (Array.isArray(p.new_value)) { emails.clear(); for (const em of p.new_value) if (typeof em === "string") emails.add(em); } break;
      }
    }
  }
  const recentInteraction = interactions.length ? interactions[interactions.length - 1].summary : "";
  const parts = [];
  if (relationship_to_me) parts.push(relationship_to_me);
  if (recentInteraction && !isSimilar(relationship_to_me, recentInteraction)) parts.push(recentInteraction);
  const one_paragraph_summary = parts.join(" · ");
  return {
    person_id: personId,
    name,
    company,
    title,
    category,
    phones: Array.from(phones),
    emails: Array.from(emails),
    relationship_to_me,
    last_touch,
    one_paragraph_summary,
    observations: {
      interactions: interactions.slice(-20),
      recent_corrections: corrections.slice(-10),
      total: rows.length,
    },
  };
}

const env = Object.fromEntries(
  readFileSync("/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/.env.local", "utf8").split("\n")
    .filter(l => l && !l.startsWith("#")).map(l => { const i=l.indexOf("="); return [l.slice(0,i).trim(), l.slice(i+1).trim()]; })
);

const pool = new pg.Pool({ connectionString: env.SUPABASE_DB_URL });
const { rows } = await pool.query(`
  SELECT o.id, o.observed_at, o.kind, o.evidence_pointer, o.confidence, o.reasoning, o.payload, o.ingested_at, o.user_id, o.observer
  FROM observations o
  JOIN person_observation_links l ON l.observation_id = o.id
  WHERE l.person_id = '67050b91-5011-4ba6-b230-9a387879717a'
    AND o.user_id = 'dbb398c2-1eff-4eee-ae10-bad13be5fda7'
  ORDER BY o.observed_at
`);
// Normalize ISO format to match API
for (const r of rows) {
  const d = new Date(r.observed_at);
  r.observed_at = d.toISOString().replace(/\.\d{3}Z$/, val => val === ".000Z" ? "+00:00" : val.replace("Z", "+00:00"));
}
const card = assembleCard("67050b91-5011-4ba6-b230-9a387879717a", rows);
console.log(JSON.stringify({ card }, null, 2));
await pool.end();
