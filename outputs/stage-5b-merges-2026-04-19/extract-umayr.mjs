// Pull the Umayr block out of spot-check-raw.json into umayr-card.json so we
// can diff it against the baseline without re-querying claw.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const arr = JSON.parse(
  fs.readFileSync(path.join(__dirname, "spot-check-raw.json"), "utf8"),
);
const umayr = arr.find((e) => e.person_id === "67050b91-5011-4ba6-b230-9a387879717a");
if (!umayr?.ok) {
  throw new Error("Umayr not found or errored");
}
fs.writeFileSync(
  path.join(__dirname, "umayr-card.json"),
  JSON.stringify(umayr.card, null, 2) + "\n",
);
console.log("wrote umayr-card.json");
