// Bootstrap importer: read a JSONL file of raw_events-shaped objects,
// validate each line with the shared zod schema, and POST valid rows
// in batches of 500. Invalid rows are collected and reported but never
// silently dropped.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { rawEventSchema } from "../src/lib/raw-events-schema.ts";

export async function readJsonl(path) {
  const rl = createInterface({
    input: createReadStream(path, "utf8"),
    crlfDelay: Infinity,
  });
  const valid = [];
  const invalid = [];
  let line_no = 0;
  for await (const raw of rl) {
    line_no += 1;
    if (!raw.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      invalid.push({ line_no, error: `json parse: ${e.message}` });
      continue;
    }
    const result = rawEventSchema.safeParse(parsed);
    if (result.success) {
      valid.push(result.data);
    } else {
      invalid.push({
        line_no,
        error: result.error.issues
          .map((i) => i.path.join(".") || "(root)")
          .join(","),
      });
    }
  }
  return { valid, invalid };
}

async function postBatch(url, apiKey, rows) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST failed: ${res.status} ${text}`);
  }
  return res.json();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node scripts/import-jsonl-to-raw-events.mjs <file.jsonl>");
    process.exit(2);
  }
  const { valid, invalid } = await readJsonl(path);
  console.log(`valid=${valid.length} invalid=${invalid.length}`);
  if (invalid.length) {
    for (const err of invalid.slice(0, 10)) {
      console.log(`  line ${err.line_no}: ${err.error}`);
    }
  }

  const apiUrl =
    process.env.ORBIT_API_URL || "https://orbit-mu-roan.vercel.app/api/v1";
  const apiKey = process.env.ORBIT_API_KEY;
  if (!apiKey) {
    console.log("ORBIT_API_KEY not set — dry-run only, not posting.");
    process.exit(0);
  }

  for (let i = 0; i < valid.length; i += 500) {
    const chunk = valid.slice(i, i + 500);
    const resp = await postBatch(`${apiUrl}/raw_events`, apiKey, chunk);
    console.log(
      `batch ${Math.floor(i / 500)}: inserted=${resp.inserted} updated=${resp.updated}`,
    );
  }
}
