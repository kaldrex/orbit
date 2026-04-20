import pg from "pg";
import { readFileSync } from "node:fs";
const env = Object.fromEntries(readFileSync("/Users/sanchay/Documents/projects/personal/orbit/.claude/worktrees/autonomous-2026-04-19/.env.local","utf8").split("\n").filter(l=>l&&!l.startsWith("#")).map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const pool = new pg.Pool({connectionString: env.SUPABASE_DB_URL});
const { rows } = await pool.query(`SELECT o.id, o.observed_at, o.kind, o.payload FROM observations o JOIN person_observation_links l ON l.observation_id=o.id WHERE l.person_id='9e7c0448-dd3b-437c-9cda-c512dbc5764b' AND o.user_id='dbb398c2-1eff-4eee-ae10-bad13be5fda7' ORDER BY o.observed_at`);
let name=null,category=null,company=null,title=null,r2m="";
const phones=new Set(), emails=new Set();
for (const row of rows) {
  if (row.kind==="person") {
    const p=row.payload;
    if (p.name) name=p.name;
    if (p.company!==undefined && p.company!==null) company=p.company;
    if (p.title!==undefined && p.title!==null) title=p.title;
    if (p.category) category=p.category;
    if (p.relationship_to_me) r2m=p.relationship_to_me;
    for (const ph of p.phones??[]) phones.add(ph);
    for (const em of p.emails??[]) emails.add(em);
  } else if (row.kind==="correction") {
    const p=row.payload;
    if (p.field==="name" && typeof p.new_value==="string") name=p.new_value;
    if (p.field==="category" && typeof p.new_value==="string") category=p.new_value;
    if (p.field==="company" && (p.new_value===null||typeof p.new_value==="string")) company=p.new_value;
    if (p.field==="title" && (p.new_value===null||typeof p.new_value==="string")) title=p.new_value;
    if (p.field==="relationship_to_me" && typeof p.new_value==="string") r2m=p.new_value;
  }
}
console.log(JSON.stringify({name,company,title,category,relationship_to_me:r2m,phones:[...phones],emails:[...emails]},null,2));
await pool.end();
