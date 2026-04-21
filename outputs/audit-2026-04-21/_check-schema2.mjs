import { readFileSync } from "node:fs";
import pg from "pg";
const e = Object.fromEntries(readFileSync("/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/.env.local","utf8").split("\n").filter(l=>l&&!l.startsWith("#")&&l.includes("=")).map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(),l.slice(i+1).trim()]}));
const c = new pg.Client({connectionString: e.SUPABASE_DB_URL}); await c.connect();
for (const t of ["persons","person_observation_links","person_topics"]) {
  console.log("===", t, "===");
  const r = await c.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position`,[t]);
  for (const row of r.rows) console.log(" ", row.column_name, row.data_type);
  const rc = await c.query(`SELECT count(*)::int c FROM ${t}`);
  console.log("  rows:", rc.rows[0].c);
}
await c.end();
