#!/usr/bin/env node
// Bleed replay — M8 verification.
//
// Runs the production resolve-participants Cypher against a synthetic,
// isolated userId namespace so it can be exercised end-to-end without
// touching real user data. Seeds the canonical Persons from the fixture's
// expected_canonicals, replays each signal, then asserts:
//
//   new_dupes = (Persons in namespace after replay) - (distinct expected ids)
//
// Cleans up the namespace at the end. Exits 0 when new_dupes === 0.
//
// Usage: node scripts/replay-bleed.js [--keep]  # --keep skips cleanup

import neo4j from "neo4j-driver";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RESOLVE_PARTICIPANTS_CYPHER, normalizeEmail, normalizePhone } from "../src/lib/cypher/resolve-participants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const FIXTURE = resolve(REPO_ROOT, "scripts/fixtures/bleed-test-signals.json");
const REPLAY_USER_ID = "__replay_user__";
const REPLAY_SELF_ID = "__replay_self__";
const KEEP = process.argv.includes("--keep");

function loadEnv() {
  const candidates = [
    resolve(REPO_ROOT, ".env.local"),
    resolve(REPO_ROOT, "..", "..", "..", ".env.local"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return Object.fromEntries(
        readFileSync(p, "utf-8")
          .split("\n")
          .filter((l) => l && !l.startsWith("#"))
          .map((l) => {
            const i = l.indexOf("=");
            return [l.slice(0, i), l.slice(i + 1).trim()];
          })
      );
    }
  }
  throw new Error("No .env.local found");
}

const env = loadEnv();
const driver = neo4j.driver(
  env.NEO4J_URI,
  neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD)
);
const dbName = env.NEO4J_DATABASE || "neo4j";

async function cy(query, params = {}) {
  const s = driver.session({ database: dbName, defaultAccessMode: neo4j.session.WRITE });
  try {
    const r = await s.run(query, params);
    return r.records.map((rec) => {
      const o = {};
      for (const k of rec.keys) {
        const v = rec.get(k);
        o[k] = neo4j.isInt(v) ? v.toNumber() : v;
      }
      return o;
    });
  } finally {
    await s.close();
  }
}

function randId() {
  return `p_${Math.random().toString(36).slice(2, 10)}`;
}

async function cleanup() {
  await cy(
    `MATCH (p:Person {userId: $uid}) DETACH DELETE p`,
    { uid: REPLAY_USER_ID }
  );
}

async function main() {
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf-8"));

  // Always start from a clean slate.
  await cleanup();

  // Seed canonical Persons. These mirror real-world identifiers so the
  // resolution cascade has something to match against. We derive emails
  // from the fixture signals themselves so the seed data stays in sync.
  const canonicals = fixture.expected_canonicals;
  const seedData = {
    [canonicals.ramon]: { name: "Ramon Berrios", email: "ramongberrios@gmail.com", phone: null, category: "founder" },
    [canonicals.eric_anysphere]: { name: "Eric Guo", email: "eric@anysphere.co", phone: null, category: "founder" },
    [canonicals.ashish]: { name: "Ashish", email: "as@millionlights.uk", phone: null, category: "other" },
    [canonicals.ashutosh]: { name: "Ashutosh Shrivastava", email: "shahidshrivastava.01@gmail.com", phone: null, category: "other" },
  };
  await cy(
    `UNWIND $seeds AS s
     CREATE (:Person {
       id: s.id, userId: $uid, name: s.name, email: s.email, phone: s.phone,
       category: s.category, relationship_score: 3, source: "replay_seed"
     })`,
    {
      uid: REPLAY_USER_ID,
      seeds: Object.entries(seedData).map(([id, v]) => ({ id, ...v })),
    }
  );
  // Self node
  await cy(
    `CREATE (:Person {
       id: $selfId, userId: $uid, name: "Sanchay Thalnerkar",
       email: "sanchaythalnerkar@gmail.com",
       category: "self", relationship_score: 10, source: "replay_seed"
     })`,
    { uid: REPLAY_USER_ID, selfId: canonicals.self }
  );

  // Build the self identity signature — same shape buildSelfIdentity produces
  // on the real server.
  const selfIdentity = {
    emails: [
      "sanchaythalnerkar@gmail.com",
      "sanchay.thalnerkar@localhosthq.com",
      "sanchay@localhosthq.com",
    ],
    phones: [],
    names: ["sanchay", "sanchay thalnerkar", "sanchay t"],
  };

  // Collect participants exactly as the ingest route does: group by strongest
  // identifier (email > phone > lowercased name) so multiple signals for the
  // same person collapse to a single resolve item in the batch.
  const identKey = (p) => {
    if (p.email) return `e:${p.email.toLowerCase()}`;
    if (p.phone) return `p:${p.phone}`;
    return `n:${p.name.toLowerCase()}`;
  };

  const byIdent = new Map(); // ident key → {name, email, phone}
  // Track every individual signal input with the ident key it collapsed to.
  const signalLog = []; // [{ case, name, email, key, expected }]

  const addParticipantsFromInteraction = (interaction, caseLabel, expected) => {
    for (const p of interaction.participants || []) {
      const name = p.name;
      const email = normalizeEmail(p.email ?? null);
      const phone = normalizePhone(p.phone ?? null);
      const candidate = { name, email, phone };
      const key = identKey(candidate);
      const existing = byIdent.get(key);
      if (!existing) {
        byIdent.set(key, { name, email, phone });
      } else {
        if (name && name.length > (existing.name?.length ?? 0)) existing.name = name;
        if (!existing.email && email) existing.email = email;
        if (!existing.phone && phone) existing.phone = phone;
      }
      signalLog.push({ case: caseLabel, name, email, key, expected });
    }
  };

  for (const s of fixture.signals) {
    addParticipantsFromInteraction(
      s.interaction,
      s.case,
      s.expected_id || s.expected_ids
    );
    if (Array.isArray(s.dedup_test)) {
      for (const extra of s.dedup_test) {
        addParticipantsFromInteraction(
          extra,
          s.case + " (dedup)",
          s.expected_id || "__NEW__"
        );
      }
    }
  }

  // One resolve item per unique identity key. New IDs are stable per key.
  const batchItems = Array.from(byIdent.entries()).map(([key, p]) => ({
    key,
    name: p.name,
    email: p.email,
    phone: p.phone,
    newId: randId(),
  }));

  const resolved = await cy(RESOLVE_PARTICIPANTS_CYPHER, {
    userId: REPLAY_USER_ID,
    batch: batchItems.map(({ key, ...rest }) => rest),
    selfEmails: selfIdentity.emails,
    selfPhones: selfIdentity.phones,
    selfNames: selfIdentity.names,
  });

  // Map ident key → resolved id (matches by order of the batch)
  const keyToId = new Map();
  for (let i = 0; i < batchItems.length; i++) {
    keyToId.set(batchItems[i].key, resolved[i].id);
  }

  // Resolve every original signal through its collapsed key.
  const actualIds = signalLog.map((s) => keyToId.get(s.key));

  // Count how many NEW Person nodes the replay created.
  // A "new" id is one that matches a newId we sent in (i.e., not a seed).
  const seedIds = new Set([...Object.keys(seedData), canonicals.self]);
  const createdCount = actualIds.filter((id) => !seedIds.has(id)).length;

  // Count distinct new ids (multiple signals for the same unknown person
  // should converge to one new node, not N).
  const distinctNew = new Set(actualIds.filter((id) => !seedIds.has(id)));

  // Per-signal report
  console.log("");
  console.log("─".repeat(78));
  console.log("  Bleed replay — M8");
  console.log("─".repeat(78));
  console.log("");

  let mismatches = 0;
  for (let i = 0; i < signalLog.length; i++) {
    const s = signalLog[i];
    const actual = actualIds[i];
    const exp = s.expected;
    const expectedOk =
      exp === "__NEW__"
        ? !seedIds.has(actual)
        : Array.isArray(exp)
        ? exp.includes(actual)
        : actual === exp;
    const mark = expectedOk ? "✓" : "✗";
    if (!expectedOk) mismatches++;
    const expStr = Array.isArray(exp) ? exp.join(" | ") : String(exp);
    console.log(`  ${mark}  ${s.case}`);
    console.log(
      `       name=${JSON.stringify(s.name).padEnd(28)} email=${s.email || "—"}`
    );
    console.log(
      `       expected=${expStr.padEnd(24)} got=${actual}${expectedOk ? "" : "  ← MISMATCH"}`
    );
  }

  // Distinct-new check: count how many distinct NEW Person nodes got created,
  // versus how many unique __NEW__ ident keys the fixture has.
  const expectedNewKeys = new Set(
    signalLog.filter((s) => s.expected === "__NEW__").map((s) => s.key)
  );
  const expectedNewCount = expectedNewKeys.size;
  const overcreated = distinctNew.size - expectedNewCount;

  console.log("");
  console.log("  Summary");
  console.log(`    total signals replayed:  ${signalLog.length}`);
  console.log(`    collapsed to batch of:   ${batchItems.length}`);
  console.log(`    per-signal mismatches:   ${mismatches}`);
  console.log(`    distinct NEW Persons:    ${distinctNew.size} (expected ${expectedNewCount})`);
  console.log(`    new duplicates (M8):     ${Math.max(0, overcreated)}`);
  console.log("");

  if (!KEEP) {
    await cleanup();
    console.log("  (replay namespace cleaned up — use --keep to inspect)");
  } else {
    console.log(`  (kept replay data under userId=${REPLAY_USER_ID})`);
  }

  const failed = mismatches > 0 || overcreated > 0;
  await driver.close();
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await cleanup();
  } catch {}
  await driver.close();
  process.exit(2);
});
