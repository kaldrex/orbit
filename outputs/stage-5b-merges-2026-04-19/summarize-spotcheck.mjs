// Pull a compact table of { person_id, name, phones.len, emails.len } from
// spot-check-raw.json for inclusion in report.md.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arr = JSON.parse(
  fs.readFileSync(path.join(__dirname, "spot-check-raw.json"), "utf8"),
);

const rows = arr
  .filter((e) => e.person_id !== "67050b91-5011-4ba6-b230-9a387879717a")
  .map((e) => {
    const c = e.card?.card ?? {};
    return {
      person_id: e.person_id,
      ok: e.ok,
      name: c.name ?? null,
      phone_count: Array.isArray(c.phones) ? c.phones.length : 0,
      email_count: Array.isArray(c.emails) ? c.emails.length : 0,
      category: c.category ?? null,
      total_observations: c.observations?.total ?? null,
    };
  });

fs.writeFileSync(
  path.join(__dirname, "spot-check-summary.json"),
  JSON.stringify(rows, null, 2) + "\n",
);
console.log(JSON.stringify(rows, null, 2));
