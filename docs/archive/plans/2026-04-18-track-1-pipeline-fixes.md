# Track 1 — Week-1 Pipeline Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close four low-risk pipeline bugs that are actively causing data loss or blocking capability. No architecture changes. Every fix must ship with a test that will fail again if the bug regresses.

**Architecture:** purely additive — the Gmail fix hardens an existing availability probe; the INTERACTED test locks in fields the current ingest already writes; `group_participants` import adds a new weak edge type (`CO_PRESENT_IN`, weight 0.1); the LID→phone bridge is a new nightly script seeded from a snapshot.

**Tech Stack:**
- Vitest (new — currently no JS test runner; pick Vitest for ESM-first Node)
- `better-sqlite3` (already a transitive dep via plugin) — used by new wacli importer tests
- Node `child_process.execFileSync` (existing — safe form, no shell)
- Neo4j driver (existing `src/lib/neo4j.ts`)
- GitHub Actions for CI (new `.github/workflows/test.yml`)

**Non-goals:**
- Don't touch ingest schema beyond what commit `aa44a40` already did
- Don't rewrite connectors
- Don't add new API endpoints (that's Track 2/3)
- Don't modify UI (that's Track 5)

**Evidence location:** `outputs/verification/2026-04-18-track1/`

---

## File Structure

**Created:**
- `vitest.config.ts` — test runner config
- `tests/unit/gmail-availability.test.js` — unit test for Gmail connector `isAvailable()` under empty PATH
- `tests/unit/interacted-edge-fields.test.ts` — regression test asserting all preserved fields land on `INTERACTED`
- `tests/integration/group-participants-import.test.js` — asserts `CO_PRESENT_IN` edges created with weight 0.1
- `tests/integration/lid-bridge.test.js` — asserts the seeded 35 matches resolve
- `tests/fixtures/wacli-minimal.db` — SQLite fixture, 10 chats, 50 msgs, 5 contacts, 2 groups
- `tests/fixtures/build-wacli-minimal.mjs` — deterministic script that rebuilds the fixture DB
- `tests/fixtures/lid-seed.json` — 35 seeded LID→phone matches (synthetic or anonymized)
- `scripts/import-group-participants.mjs` — Neo4j importer: group membership → `CO_PRESENT_IN` edges
- `scripts/lid-bridge-nightly.mjs` — nightly job entry point
- `.github/workflows/test.yml` — CI wiring

**Modified:**
- `packages/orbit-plugin/connectors/gmail/connector.js` — replace `which gws` probe with a deterministic path resolver
- `packages/orbit-plugin/lib/capabilities.js` — use the same resolver so capability report and connector availability agree
- `package.json` — add `"test": "vitest run"`, `devDependencies.vitest`, `devDependencies.better-sqlite3`
- `outputs/verification-log.md` — append evidence rows
- `src/lib/cypher/co-present-edge.cypher` — new pure-Cypher file

---

## Task 1: Wire up Vitest + CI (CC-1)

**Why first:** every subsequent task has an L1 test step that will fail until this is in place.

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json`
- Create: `.github/workflows/test.yml`
- Create: `tests/unit/sanity.test.js`

- [ ] **Step 1: Add Vitest dev dep**

```bash
npm install --save-dev vitest @vitest/coverage-v8
```

- [ ] **Step 2: Create vitest config**

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/unit/**/*.test.{js,ts}",
      "tests/integration/**/*.test.{js,ts}",
      "packages/**/*.test.{js,ts}",
    ],
    exclude: ["**/node_modules/**"],
    testTimeout: 15_000,
    environment: "node",
  },
});
```

- [ ] **Step 3: Add scripts to package.json**

Edit `package.json` so `scripts` contains:

```json
"test": "vitest run",
"test:watch": "vitest",
"test:unit": "vitest run tests/unit",
"test:integration": "vitest run tests/integration"
```

- [ ] **Step 4: Write a sanity test**

```js
// tests/unit/sanity.test.js
import { describe, it, expect } from "vitest";

describe("sanity", () => {
  it("1 + 1 equals 2", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Run it to verify the runner is wired**

```bash
npm test
```

Expected: `1 passed`.

- [ ] **Step 6: Add CI workflow**

```yaml
# .github/workflows/test.yml
name: test
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
      - run: npm ci
      - run: npm run lint --if-present
      - run: npm test
```

- [ ] **Step 7: Commit**

```bash
git add vitest.config.ts package.json package-lock.json tests/unit/sanity.test.js .github/workflows/test.yml
git commit -m "test: add vitest runner + CI workflow"
```

---

## Task 2: Regression test for INTERACTED-edge field preservation

**Why:** commit `aa44a40` added `source_event_id` / `thread_id` / `body_preview` / `direction` / `source` to the `INTERACTED` edge. Without a test, the next Cypher tweak can silently drop them — exactly the failure mode testing spec §2.3 calls out.

**Files:**
- Modify: `src/lib/neo4j.ts` (read only)
- Create: `tests/unit/interacted-edge-fields.test.ts`

- [ ] **Step 1: Read `src/lib/neo4j.ts` to find the exact Cypher**

Use the Read tool on `src/lib/neo4j.ts` and capture the Cypher used inside `batchCreateInteractions`. Note the exact property names written to the edge.

- [ ] **Step 2: Write the regression test**

```ts
// tests/unit/interacted-edge-fields.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "..", "..");
const src = readFileSync(resolve(REPO, "src/lib/neo4j.ts"), "utf8");

const REQUIRED_FIELDS = [
  "source_event_id",
  "thread_id",
  "body_preview",
  "direction",
  "source",
];

describe("INTERACTED edge preserves audit fields (regression against aa44a40)", () => {
  for (const field of REQUIRED_FIELDS) {
    it(`Cypher for INTERACTED sets \`${field}\``, () => {
      const idx = src.indexOf("INTERACTED");
      expect(idx, "INTERACTED not found in src/lib/neo4j.ts").toBeGreaterThan(-1);
      const window = src.slice(idx, idx + 2_000);
      const rDotField = new RegExp(`r\\.${field}\\b`);
      const mapKey = new RegExp(`\\b${field}\\s*:`);
      expect(
        rDotField.test(window) || mapKey.test(window),
        `Field \`${field}\` must be written on the INTERACTED edge.`
      ).toBe(true);
    });
  }
});
```

- [ ] **Step 3: Run it to verify it passes**

```bash
npm run test:unit -- tests/unit/interacted-edge-fields.test.ts
```

Expected: `5 passed`.

- [ ] **Step 4: Sanity-check it fails when a field is removed**

Temporarily rename `source_event_id` to `x_source_event_id` in `src/lib/neo4j.ts`, rerun, confirm fail, then revert with `git checkout src/lib/neo4j.ts`.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/interacted-edge-fields.test.ts
git commit -m "test(ingest): lock in INTERACTED audit-field preservation"
```

---

## Task 3: Fix Gmail `isAvailable()` for gateway subprocess

**Why:** `execFileSync("which","gws")` depends on PATH. The gateway subprocess launches connectors with a minimal environment and `gws` is not found, so the capability report drops Gmail.

**Approach:** try a fixed set of candidate absolute paths in priority order, then fall back to PATH. Expose the resolver via `capabilities.js` too so the report and the connector always agree.

**Files:**
- Create: `packages/orbit-plugin/lib/gws-path.js`
- Modify: `packages/orbit-plugin/connectors/gmail/connector.js`
- Modify: `packages/orbit-plugin/lib/capabilities.js`
- Create: `tests/unit/gmail-availability.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/unit/gmail-availability.test.js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveGwsPath } from "../../packages/orbit-plugin/lib/gws-path.js";

describe("resolveGwsPath", () => {
  const origPath = process.env.PATH;
  beforeEach(() => { process.env.PATH = ""; });
  afterEach(() => { process.env.PATH = origPath; });

  it("returns a known absolute path when PATH is empty and a candidate exists", () => {
    const found = resolveGwsPath({ existsSync: (p) => p === "/usr/local/bin/gws" });
    expect(found).toBe("/usr/local/bin/gws");
  });

  it("returns null when no candidate exists and PATH is empty", () => {
    const found = resolveGwsPath({ existsSync: () => false, which: () => null });
    expect(found).toBeNull();
  });

  it("falls back to the which-stub when no fixed candidate hits", () => {
    const found = resolveGwsPath({
      existsSync: () => false,
      which: () => "/opt/custom/gws",
    });
    expect(found).toBe("/opt/custom/gws");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run test:unit -- tests/unit/gmail-availability.test.js
```

Expected: FAIL — "Cannot find module '…/lib/gws-path.js'".

- [ ] **Step 3: Create the resolver**

```js
// packages/orbit-plugin/lib/gws-path.js
import { existsSync as fsExistsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const CANDIDATES = () => [
  "/usr/local/bin/gws",
  "/usr/bin/gws",
  "/opt/homebrew/bin/gws",
  join(homedir(), ".local", "bin", "gws"),
  join(homedir(), "bin", "gws"),
];

function defaultWhich() {
  try {
    const out = execFileSync("which", ["gws"], { encoding: "utf8" }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function resolveGwsPath(deps = {}) {
  const existsSyncFn = deps.existsSync || fsExistsSync;
  const which = deps.which || defaultWhich;
  for (const p of CANDIDATES()) {
    if (existsSyncFn(p)) return p;
  }
  return which();
}
```

- [ ] **Step 4: Run the test — expect 3 passed**

```bash
npm run test:unit -- tests/unit/gmail-availability.test.js
```

- [ ] **Step 5: Wire the resolver into the Gmail connector**

Edit `packages/orbit-plugin/connectors/gmail/connector.js` — add the import and replace `isAvailable`:

```js
// top of file — add:
import { resolveGwsPath } from "../../lib/gws-path.js";

// in the class — replace isAvailable() and the command references:
  isAvailable() {
    this._gwsPath = this._gwsPath ?? resolveGwsPath();
    return this._gwsPath !== null;
  }

  _gws() {
    if (!this._gwsPath) this._gwsPath = resolveGwsPath();
    if (!this._gwsPath) throw new Error("gws not found on disk or PATH");
    return this._gwsPath;
  }
```

Then update both existing `execFileSync("gws", …)` call sites in the file — change the first arg from the literal string `"gws"` to `this._gws()`.

- [ ] **Step 6: Share the resolver with capabilities.js**

Edit `packages/orbit-plugin/lib/capabilities.js`:

```js
import { resolveGwsPath } from "./gws-path.js";
// ...
const gwsPath = resolveGwsPath();
const gwsOn = gwsPath !== null;
```

…and replace whatever `cliExists("gws")` boolean was used with `gwsOn`. Keep `gwsPath` in the report for debugging.

- [ ] **Step 7: Run the full unit suite**

```bash
npm run test:unit
```

Expected: all tests pass including the 3 new ones.

- [ ] **Step 8: Capture live verification evidence (deferred if no claw access)**

On `claw`:

```bash
ssh claw "systemctl --user restart openclaw-gateway.service && sleep 5 && journalctl --user -u openclaw-gateway -n 50 --no-pager | grep -i 'channels='" \
  > outputs/verification/2026-04-18-track1/gateway-channels-after-fix.txt
```

Expected line: `channels=whatsapp,gmail,calendar`.

If claw access is not available at plan-execution time, record that in `outputs/verification-log.md` as "local tests green; live claw verification deferred to next deploy window" — do NOT fake the artifact.

- [ ] **Step 9: Commit**

```bash
git add packages/orbit-plugin/lib/gws-path.js \
        packages/orbit-plugin/connectors/gmail/connector.js \
        packages/orbit-plugin/lib/capabilities.js \
        tests/unit/gmail-availability.test.js
git commit -m "fix(gmail): resolve gws under gateway subprocess PATH"
```

---

## Task 4: Build `wacli-minimal.db` fixture (CC-2)

**Why:** every downstream integration test (group_participants, LID bridge, wacli importer) needs a deterministic, committed SQLite fixture.

**Files:**
- Create: `tests/fixtures/build-wacli-minimal.mjs`
- Create: `tests/fixtures/wacli-minimal.db`

- [ ] **Step 1: Write the fixture builder**

```js
// tests/fixtures/build-wacli-minimal.mjs
import Database from "better-sqlite3";
import { resolve } from "node:path";
import { rmSync } from "node:fs";

const out = resolve(new URL(".", import.meta.url).pathname, "wacli-minimal.db");
try { rmSync(out); } catch {}

const db = new Database(out);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE chats (
  jid TEXT PRIMARY KEY,
  name TEXT,
  is_group INTEGER,
  last_msg_ts INTEGER
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  chat_jid TEXT NOT NULL,
  sender_jid TEXT,
  direction TEXT,
  body_preview TEXT,
  ts INTEGER
);
CREATE TABLE contacts (
  jid TEXT PRIMARY KEY,
  full_name TEXT,
  push_name TEXT,
  first_name TEXT,
  business_name TEXT,
  phone TEXT
);
CREATE TABLE group_participants (
  group_jid TEXT NOT NULL,
  member_jid TEXT NOT NULL,
  PRIMARY KEY (group_jid, member_jid)
);
`);

const iChat = db.prepare("INSERT INTO chats VALUES (?,?,?,?)");
const iMsg  = db.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?)");
const iCon  = db.prepare("INSERT INTO contacts VALUES (?,?,?,?,?,?)");
const iGP   = db.prepare("INSERT INTO group_participants VALUES (?,?)");

const contacts = [
  ["911111111111@s.whatsapp.net", "Alice Kumar",   null,       "Alice",  null,          "+911111111111"],
  ["912222222222@s.whatsapp.net", "Bob Singh",     "Bobby",    "Bob",    null,          "+912222222222"],
  ["913333333333@s.whatsapp.net", null,            "Charlie",  null,     null,          "+913333333333"],
  ["914444444444@s.whatsapp.net", null,            null,       null,     "Dee's Bakery","+914444444444"],
  ["915555555555@s.whatsapp.net", "Eve Thakur",    null,       "Eve",    null,          "+915555555555"],
];
for (const c of contacts) iCon.run(...c);

const chats = [
  ["911111111111@s.whatsapp.net",     "Alice Kumar", 0, 1_713_400_000],
  ["912222222222@s.whatsapp.net",     "Bobby",       0, 1_713_410_000],
  ["913333333333@s.whatsapp.net",     "Charlie",     0, 1_713_420_000],
  ["914444444444@s.whatsapp.net",     "Dee's Bakery",0, 1_713_430_000],
  ["915555555555@s.whatsapp.net",     "Eve Thakur",  0, 1_713_440_000],
  ["916666666666@s.whatsapp.net",     null,          0, 1_713_450_000],
  ["120363000000000001@g.us",         "Team Orbit",  1, 1_713_460_000],
  ["120363000000000002@g.us",         "YC W26",      1, 1_713_470_000],
  ["99999999@lid",                    null,          0, 1_713_480_000],
  ["88888888@lid",                    null,          0, 1_713_490_000],
];
for (const c of chats) iChat.run(...c);

let msgId = 0;
const pushMsg = (chat, sender, dir, body, ts) =>
  iMsg.run(`msg-${String(++msgId).padStart(4, "0")}`, chat, sender, dir, body, ts);

for (const dmChat of chats.slice(0, 6)) {
  for (let i = 0; i < 5; i++) {
    pushMsg(dmChat[0], i % 2 === 0 ? dmChat[0] : "self",
            i % 2 === 0 ? "inbound" : "outbound",
            `hello ${i}`, dmChat[3] + i * 60);
  }
}
for (const groupChat of chats.slice(6, 8)) {
  for (let i = 0; i < 10; i++) {
    pushMsg(groupChat[0], contacts[i % 5][0], "inbound",
            `group msg ${i}`, groupChat[3] + i * 60);
  }
}

const g1 = "120363000000000001@g.us";
const g2 = "120363000000000002@g.us";
for (const c of contacts) iGP.run(g1, c[0]);
iGP.run(g1, "self");
iGP.run(g2, contacts[0][0]);
iGP.run(g2, contacts[1][0]);
iGP.run(g2, "self");
iGP.run(g2, "916666666666@s.whatsapp.net");
iGP.run(g2, "99999999@lid");
iGP.run(g2, "88888888@lid");

db.close();
console.log("wrote", out);
```

- [ ] **Step 2: Ensure `better-sqlite3` is installed**

```bash
npm install --save-dev better-sqlite3
```

- [ ] **Step 3: Run the builder**

```bash
node tests/fixtures/build-wacli-minimal.mjs
```

Expected: `wrote …/tests/fixtures/wacli-minimal.db`. File size < 100 KB.

- [ ] **Step 4: Sanity query**

```bash
sqlite3 tests/fixtures/wacli-minimal.db "SELECT COUNT(*) FROM messages; SELECT COUNT(*) FROM group_participants;"
```

Expected: `50` and `14`.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/build-wacli-minimal.mjs tests/fixtures/wacli-minimal.db package.json package-lock.json
git commit -m "test(fixtures): commit deterministic wacli-minimal.db for L2 tests"
```

---

## Task 5: Import `group_participants` as `CO_PRESENT_IN` edges

**Why:** today the WA group membership table is dropped on the floor. The design spec §2 / §7 calls out materializing it as a weak signal so Hardeep's card can show "21 shared WhatsApp groups".

**Edge contract:**
- Direction: undirected, one edge per unordered person pair
- Weight: **0.1** (fixed; does not scale with group size)
- Properties: `source: "wa_group"`, `group_jids: [jid1, jid2, …]`
- MERGE key: `(a:Person)-[r:CO_PRESENT_IN]-(b:Person)` on sorted IDs

**Files:**
- Create: `src/lib/cypher/co-present-edge.cypher`
- Create: `scripts/import-group-participants.mjs`
- Create: `tests/integration/group-participants-import.test.js`

- [ ] **Step 1: Write the Cypher**

```cypher
// src/lib/cypher/co-present-edge.cypher
// Usage: params { groupJid: string, memberIds: [string] }
UNWIND $memberIds AS aId
UNWIND $memberIds AS bId
WITH aId, bId
WHERE aId < bId
MATCH (a:Person {id: aId}), (b:Person {id: bId})
MERGE (a)-[r:CO_PRESENT_IN]-(b)
  ON CREATE SET
    r.weight = 0.1,
    r.source = 'wa_group',
    r.group_jids = [$groupJid],
    r.first_seen = datetime()
  ON MATCH SET
    r.group_jids =
      CASE WHEN $groupJid IN r.group_jids
           THEN r.group_jids
           ELSE r.group_jids + $groupJid END,
    r.last_seen = datetime()
RETURN count(r) AS edges_touched
```

- [ ] **Step 2: Write the failing integration test**

```js
// tests/integration/group-participants-import.test.js
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { resolve } from "node:path";
import { importGroupParticipants } from "../../scripts/import-group-participants.mjs";

function makeFakeNeo4j() {
  const calls = [];
  return {
    runCypher: async (cypher, params) => {
      calls.push({ cypher, params });
      return { records: [{ get: () => 1 }] };
    },
    calls,
  };
}

describe("importGroupParticipants", () => {
  const fixture = resolve(__dirname, "..", "fixtures", "wacli-minimal.db");

  it("emits one Cypher call per group with ≥2 members, and correct lists", async () => {
    const db = new Database(fixture, { readonly: true });
    const fake = makeFakeNeo4j();
    const result = await importGroupParticipants({ db, runCypher: fake.runCypher });
    expect(result.groups_processed).toBe(2);
    expect(fake.calls.length).toBe(2);
    const g1 = fake.calls.find((c) => c.params.groupJid === "120363000000000001@g.us");
    expect(g1).toBeDefined();
    expect(g1.params.memberIds).toHaveLength(6);
  });

  it("does not emit for groups with <2 members", async () => {
    const emptyDb = new Database(":memory:");
    emptyDb.exec("CREATE TABLE group_participants (group_jid TEXT, member_jid TEXT);");
    emptyDb.exec("INSERT INTO group_participants VALUES ('g1@g.us','alice@wa');");
    const fake = makeFakeNeo4j();
    const result = await importGroupParticipants({ db: emptyDb, runCypher: fake.runCypher });
    expect(result.groups_processed).toBe(0);
    expect(fake.calls.length).toBe(0);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
npm run test:integration -- tests/integration/group-participants-import.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement the importer**

```js
// scripts/import-group-participants.mjs
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CYPHER = readFileSync(
  resolve(__dirname, "..", "src", "lib", "cypher", "co-present-edge.cypher"),
  "utf8"
);

export async function importGroupParticipants({ db, runCypher, resolvePerson }) {
  resolvePerson = resolvePerson || ((jid) => jid);
  const rows = db
    .prepare(`SELECT group_jid, member_jid FROM group_participants ORDER BY group_jid`)
    .all();

  const groups = new Map();
  for (const { group_jid, member_jid } of rows) {
    const pid = resolvePerson(member_jid);
    if (!pid) continue;
    if (!groups.has(group_jid)) groups.set(group_jid, new Set());
    groups.get(group_jid).add(pid);
  }

  let processed = 0;
  for (const [groupJid, members] of groups) {
    if (members.size < 2) continue;
    await runCypher(CYPHER, {
      groupJid,
      memberIds: [...members].sort(),
    });
    processed += 1;
  }
  return { groups_processed: processed };
}
```

- [ ] **Step 5: Run the test — expect 2 passed**

```bash
npm run test:integration -- tests/integration/group-participants-import.test.js
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/cypher/co-present-edge.cypher \
        scripts/import-group-participants.mjs \
        tests/integration/group-participants-import.test.js
git commit -m "feat(ingest): import wacli group_participants as CO_PRESENT_IN (weight 0.1)"
```

---

## Task 6: LID→phone bridge nightly job scaffolding

**Why:** 9 836 `@lid` anonymous contacts sit in the side bucket. Some can be bridged to phones. Scope here = scaffolding only: seed application + name-token candidate generator. Later tracks wire up group co-occurrence and push_name signals.

**Files:**
- Create: `tests/fixtures/lid-seed.json`
- Create: `scripts/lid-bridge-nightly.mjs`
- Create: `tests/integration/lid-bridge.test.js`

- [ ] **Step 1: Seed file**

Create `tests/fixtures/lid-seed.json` with exactly 35 entries. Use real pairs from `outputs/hypothesis-test-20260418-v3/` if available, otherwise synthetic with `"synthetic": true`:

```json
{
  "generated_at": "2026-04-18",
  "source": "hypothesis-test-20260418-v3",
  "pairs": [
    { "lid": "11111111@lid", "phone": "+911111111111", "confidence": 0.95, "reason": "google_contacts_name_token", "synthetic": true }
  ]
}
```

(Repeat 35 objects total, varying the numbers.)

- [ ] **Step 2: Write the failing test**

```js
// tests/integration/lid-bridge.test.js
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applySeed, bridgeLid } from "../../scripts/lid-bridge-nightly.mjs";

const SEED = JSON.parse(
  readFileSync(resolve(__dirname, "..", "fixtures", "lid-seed.json"), "utf8")
);

describe("LID bridge", () => {
  it("applySeed returns exactly 35 mappings", () => {
    const out = applySeed(SEED);
    expect(out.pairs_applied).toBe(35);
    expect(out.rejected).toHaveLength(0);
  });

  it("rejects pairs with confidence < 0.8", () => {
    const bad = { pairs: [{ lid: "x@lid", phone: "+1", confidence: 0.5 }] };
    const out = applySeed(bad);
    expect(out.pairs_applied).toBe(0);
    expect(out.rejected).toHaveLength(1);
  });

  it("single-token name overlap produces confidence<1, never auto-merge (spec §5)", () => {
    const contacts = [
      { jid: "11111111@lid", push_name: "Alice" },
      { jid: "911111111111@s.whatsapp.net", full_name: "Alice Kumar", phone: "+911111111111" },
    ];
    const matches = bridgeLid(contacts, { minTokens: 2 });
    expect(matches).toHaveLength(1);
    expect(matches[0].confidence).toBeLessThan(1);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
npm run test:integration -- tests/integration/lid-bridge.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

```js
// scripts/lid-bridge-nightly.mjs
const MIN_CONFIDENCE = 0.8;

export function applySeed(seed) {
  const pairs_applied = [];
  const rejected = [];
  for (const p of seed.pairs || []) {
    if (typeof p.confidence !== "number" || p.confidence < MIN_CONFIDENCE) {
      rejected.push({ ...p, reason: "confidence_below_threshold" });
      continue;
    }
    pairs_applied.push(p);
  }
  return { pairs_applied: pairs_applied.length, rejected, pairs: pairs_applied };
}

function tokenize(s) {
  return String(s || "")
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ""))
    .filter((t) => t.length >= 2);
}

export function bridgeLid(contacts, { minTokens = 2 } = {}) {
  const lids = contacts.filter((c) => String(c.jid).endsWith("@lid"));
  const phones = contacts.filter((c) => String(c.jid).endsWith("@s.whatsapp.net"));
  const out = [];
  for (const l of lids) {
    const lt = new Set(tokenize(l.push_name));
    for (const p of phones) {
      const pt = new Set([
        ...tokenize(p.full_name),
        ...tokenize(p.push_name),
        ...tokenize(p.first_name),
      ]);
      const common = [...lt].filter((t) => pt.has(t));
      if (common.length >= 1) {
        out.push({
          lid: l.jid,
          phone: p.phone || p.jid,
          confidence: common.length >= minTokens ? 0.9 : 0.6,
          reason: "name_token_overlap",
          tokens: common,
        });
      }
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync: rf } = await import("node:fs");
  const seedPath = process.env.LID_SEED || "tests/fixtures/lid-seed.json";
  const seed = JSON.parse(rf(seedPath, "utf8"));
  console.log(JSON.stringify(applySeed(seed), null, 2));
}
```

- [ ] **Step 5: Run the test — expect 3 passed**

```bash
npm run test:integration -- tests/integration/lid-bridge.test.js
```

- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/lid-seed.json scripts/lid-bridge-nightly.mjs tests/integration/lid-bridge.test.js
git commit -m "feat(ingest): LID-to-phone bridge scaffolding + 35-pair seed"
```

---

## Task 7: Full-suite dry run + verification log

- [ ] **Step 1: Run the whole test suite**

```bash
npm test 2>&1 | tee outputs/verification/2026-04-18-track1/npm-test.log
```

- [ ] **Step 2: Append a summary entry to the verification log**

```
2026-04-18 HH:MM  TRACK=1  CLAIM="Week-1 pipeline fixes landed and unit/integration tested"
  evidence: outputs/verification/2026-04-18-track1/npm-test.log
  method:   npm test (vitest)
  result:   PASS — <N> tests across unit + integration suites
  commit:   <this commit sha>
  deferred: live claw verification for gws PATH fix; wacli live dry-run
            (both require infra access beyond worktree)
```

- [ ] **Step 3: Commit**

```bash
git add outputs/verification/2026-04-18-track1/ outputs/verification-log.md
git commit -m "docs(verification): Track 1 evidence trail"
```

---

## Exit gate

Track 1 is "done" when:

1. `npm test` exits 0 with ≥ 13 tests (sanity + 5 interacted + 3 gws + 2 group-participants + 3 lid-bridge)
2. `outputs/verification-log.md` has a Track=1 row with a real `npm-test.log` path
3. All Task commits have landed on a branch that CI is green on
4. Either a live-claw capability-report artifact is committed OR the deferral is explicitly recorded in the verification log

Once all four are true, check `Track 1` off on the master roadmap and move on to Track 2.
