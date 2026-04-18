# Track 2 — raw_events Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install `raw_events` as Supabase's immutable append-only ledger. Every connector writes here; every downstream projection (interactions, persons, packet) rebuilds from this table alone. Stops the ~40% field drop that occurs when connectors push directly to Neo4j.

**Architecture:** additive only. New Supabase table + RLS + idempotent upsert RPC, new Next.js route at `/api/v1/raw_events`, two bootstrap scripts (JSONL import, wacli bulk import). The plugin rewrite (signal-buffer → raw_events) is explicitly out of scope for this track — that's a separate plan, since it touches the runtime hot path.

**Tech Stack:**
- Supabase Postgres (existing)
- `@supabase/supabase-js` (existing)
- Next.js Route Handlers (existing)
- `zod` (new — schema validation at the API boundary). Install as a dep.
- `better-sqlite3` (installed in Track 1)

**Non-goals:**
- Don't rewrite the plugin signal buffer yet — still emits to `/api/v1/ingest`
- Don't touch Neo4j — projection job is Track 3
- Don't implement the `Plugin rewrite: signal-buffer → raw_events` sub-task. Split it off when Tracks 2+3 are both live.

**Evidence location:** `outputs/verification/2026-04-18-track2/`

---

## File Structure

**Created:**
- `supabase/migrations/20260418_raw_events.sql` — table + indexes + unique constraint + RLS
- `supabase/migrations/20260418_upsert_raw_events_rpc.sql` — `SECURITY DEFINER` RPC so the server-side writer can run under the user's id without a service-role key
- `src/lib/raw-events-schema.ts` — `zod` schema shared between API route and importers
- `src/app/api/v1/raw_events/route.ts` — `POST` handler
- `tests/unit/raw-events-schema.test.ts` — validation unit tests
- `tests/integration/raw-events-endpoint.test.ts` — in-process handler integration test (mocks the Supabase client)
- `scripts/import-jsonl-to-raw-events.mjs` — reads `outputs/…/*.jsonl`, POSTs to `/api/v1/raw_events`
- `scripts/import-wacli-to-raw-events.mjs` — reads `wacli.db`, bulk-upserts to raw_events
- `tests/integration/wacli-to-raw-events.test.js` — asserts the importer emits the right rows for the fixture

**Modified:**
- `package.json` — add `zod` to deps
- `outputs/verification-log.md` — append Track 2 rows

---

## Task 1: Supabase migration for `raw_events`

**Files:**
- Create: `supabase/migrations/20260418_raw_events.sql`

Schema directly from spec §2, with a `jsonb` `raw_ref` column so we can store either a reference to a blob in Supabase Storage (prod path) or the full payload (dev path).

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260418_raw_events.sql
--
-- Immutable append-only ledger of source-level events.
--
-- Every channel connector writes here, idempotent on
-- (user_id, source, source_event_id). Downstream projections
-- (interactions, persons, packet cache) all rebuild from this table.
--
-- RLS: users read/write their own rows. Schema is schemaful; evolution
-- is handled by adding nullable columns and back-filling in a separate
-- migration, never by widening types in-place.

create table if not exists public.raw_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  -- provenance
  source text not null check (source in ('whatsapp','gmail','calendar','slack','linear')),
  source_event_id text not null,
  channel text not null,
  connector_version text,

  -- time
  occurred_at timestamptz not null,
  ingested_at timestamptz not null default now(),

  -- shape
  direction text check (direction is null or direction in ('in','out')),
  thread_id text,
  participants_raw jsonb not null default '[]'::jsonb,
  participant_phones text[] not null default array[]::text[],
  participant_emails text[] not null default array[]::text[],
  body_preview text,
  attachments_present boolean not null default false,

  -- full payload or reference to one
  raw_ref jsonb,

  unique (user_id, source, source_event_id)
);

create index if not exists raw_events_user_occurred_at_idx
  on public.raw_events (user_id, occurred_at desc);
create index if not exists raw_events_user_thread_idx
  on public.raw_events (user_id, thread_id) where thread_id is not null;
create index if not exists raw_events_user_source_idx
  on public.raw_events (user_id, source);
create index if not exists raw_events_user_emails_gin
  on public.raw_events using gin (participant_emails);
create index if not exists raw_events_user_phones_gin
  on public.raw_events using gin (participant_phones);

alter table public.raw_events enable row level security;

drop policy if exists "users read own raw_events" on public.raw_events;
create policy "users read own raw_events" on public.raw_events
  for select using (auth.uid() = user_id);

drop policy if exists "users insert own raw_events" on public.raw_events;
create policy "users insert own raw_events" on public.raw_events
  for insert with check (auth.uid() = user_id);

-- No UPDATE / DELETE policies — the ledger is append-only by contract.
-- If a row must be corrected, insert a new one with a later ingested_at
-- and a raw_ref pointer to the original; application layer picks the
-- newest by (source, source_event_id).
```

- [ ] **Step 2: Commit the migration file**

```bash
git add supabase/migrations/20260418_raw_events.sql
git commit -m "feat(supabase): raw_events ledger migration"
```

- [ ] **Step 3: Apply the migration (local dev DB first)**

In a branch DB or local `supabase start`:

```bash
supabase db push
```

Expected: migration applies cleanly, `\d public.raw_events` shows the columns.

- [ ] **Step 4: Apply to production Supabase (via branch)**

```bash
supabase db push --db-url "$SUPABASE_DB_URL"
```

Additive only, so safe per spec §9. Capture output to `outputs/verification/2026-04-18-track2/db-push.log`.

---

## Task 2: Upsert RPC

**Files:**
- Create: `supabase/migrations/20260418_upsert_raw_events_rpc.sql`

**Why:** the server-side writer runs under the public anon key and passes a user_id through. RLS insert policy checks `auth.uid() = user_id` — so we need a `SECURITY DEFINER` function that accepts the user_id as a trusted parameter (the server has already authenticated the caller via `getAgentOrSessionAuth`, same pattern as `record_merge_audit`).

- [ ] **Step 1: Write the RPC**

```sql
-- supabase/migrations/20260418_upsert_raw_events_rpc.sql
create or replace function public.upsert_raw_events(
  p_user_id uuid,
  p_rows jsonb
) returns table (inserted int, updated int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted int := 0;
  v_updated int := 0;
  v_row jsonb;
begin
  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    insert into public.raw_events (
      user_id, source, source_event_id, channel, connector_version,
      occurred_at, direction, thread_id,
      participants_raw, participant_phones, participant_emails,
      body_preview, attachments_present, raw_ref
    ) values (
      p_user_id,
      v_row->>'source',
      v_row->>'source_event_id',
      v_row->>'channel',
      v_row->>'connector_version',
      (v_row->>'occurred_at')::timestamptz,
      v_row->>'direction',
      v_row->>'thread_id',
      coalesce(v_row->'participants_raw', '[]'::jsonb),
      coalesce(
        (select array_agg(value::text) from jsonb_array_elements_text(v_row->'participant_phones')),
        array[]::text[]
      ),
      coalesce(
        (select array_agg(value::text) from jsonb_array_elements_text(v_row->'participant_emails')),
        array[]::text[]
      ),
      v_row->>'body_preview',
      coalesce((v_row->>'attachments_present')::boolean, false),
      v_row->'raw_ref'
    )
    on conflict (user_id, source, source_event_id) do nothing;
    if found then
      v_inserted := v_inserted + 1;
    else
      v_updated := v_updated + 1;
    end if;
  end loop;
  return query select v_inserted, v_updated;
end;
$$;

revoke all on function public.upsert_raw_events(uuid, jsonb) from public;
grant execute on function public.upsert_raw_events(uuid, jsonb) to anon, authenticated, service_role;
```

- [ ] **Step 2: Commit + push**

```bash
git add supabase/migrations/20260418_upsert_raw_events_rpc.sql
git commit -m "feat(supabase): upsert_raw_events RPC"
supabase db push
```

---

## Task 3: zod schema shared between API + importers

**Files:**
- Create: `src/lib/raw-events-schema.ts`
- Create: `tests/unit/raw-events-schema.test.ts`

- [ ] **Step 1: Install zod**

```bash
npm install zod
```

- [ ] **Step 2: Write the failing validation test**

```ts
// tests/unit/raw-events-schema.test.ts
import { describe, it, expect } from "vitest";
import { rawEventSchema, rawEventsBatchSchema } from "../../src/lib/raw-events-schema";

const validEvent = {
  source: "whatsapp" as const,
  source_event_id: "wa_msg_0001",
  channel: "whatsapp",
  occurred_at: "2026-04-18T12:00:00Z",
  direction: "in" as const,
  thread_id: "chat_jid_abc",
  participants_raw: [{ jid: "911111111111@s.whatsapp.net" }],
  participant_phones: ["+911111111111"],
  participant_emails: [],
  body_preview: "hi",
  attachments_present: false,
  connector_version: "0.4.2",
  raw_ref: null,
};

describe("rawEventSchema", () => {
  it("accepts a valid event", () => {
    expect(rawEventSchema.parse(validEvent)).toMatchObject(validEvent);
  });

  it("rejects unknown source", () => {
    expect(() =>
      rawEventSchema.parse({ ...validEvent, source: "tiktok" })
    ).toThrow();
  });

  it("rejects missing source_event_id", () => {
    const { source_event_id: _, ...rest } = validEvent;
    expect(() => rawEventSchema.parse(rest)).toThrow();
  });

  it("rejects direction outside {in,out}", () => {
    expect(() =>
      rawEventSchema.parse({ ...validEvent, direction: "sideways" })
    ).toThrow();
  });

  it("defaults arrays and booleans", () => {
    const minimal = {
      source: "gmail" as const,
      source_event_id: "gmail_abc",
      channel: "gmail",
      occurred_at: "2026-04-18T12:00:00Z",
    };
    const parsed = rawEventSchema.parse(minimal);
    expect(parsed.participants_raw).toEqual([]);
    expect(parsed.participant_phones).toEqual([]);
    expect(parsed.participant_emails).toEqual([]);
    expect(parsed.attachments_present).toBe(false);
  });

  it("batch rejects >500 rows", () => {
    const big = Array.from({ length: 501 }, (_, i) => ({
      ...validEvent,
      source_event_id: `wa_${i}`,
    }));
    expect(() => rawEventsBatchSchema.parse(big)).toThrow();
  });
});
```

- [ ] **Step 3: Run test — expect FAIL (module missing)**

```bash
npm run test:unit -- tests/unit/raw-events-schema.test.ts
```

- [ ] **Step 4: Implement schema**

```ts
// src/lib/raw-events-schema.ts
import { z } from "zod";

export const RAW_EVENT_SOURCES = [
  "whatsapp",
  "gmail",
  "calendar",
  "slack",
  "linear",
] as const;

export const rawEventSchema = z.object({
  source: z.enum(RAW_EVENT_SOURCES),
  source_event_id: z.string().min(1).max(256),
  channel: z.string().min(1).max(64),
  connector_version: z.string().max(64).optional(),

  occurred_at: z.string().datetime(),

  direction: z.enum(["in", "out"]).optional().nullable(),
  thread_id: z.string().max(256).optional().nullable(),

  participants_raw: z.array(z.unknown()).default([]),
  participant_phones: z.array(z.string()).default([]),
  participant_emails: z.array(z.string()).default([]),

  body_preview: z
    .string()
    .max(512)
    .optional()
    .nullable()
    .transform((v) => (v == null ? v : v.slice(0, 160))),

  attachments_present: z.boolean().default(false),
  raw_ref: z.unknown().optional().nullable(),
});

export type RawEvent = z.infer<typeof rawEventSchema>;

export const MAX_BATCH = 500;
export const rawEventsBatchSchema = z
  .array(rawEventSchema)
  .min(1)
  .max(MAX_BATCH);
```

- [ ] **Step 5: Run test — expect 6 passed**

```bash
npm run test:unit -- tests/unit/raw-events-schema.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/raw-events-schema.ts tests/unit/raw-events-schema.test.ts package.json package-lock.json
git commit -m "feat(api): zod schema for raw_events batch"
```

---

## Task 4: `POST /api/v1/raw_events` route + integration test

**Files:**
- Create: `src/app/api/v1/raw_events/route.ts`
- Create: `tests/integration/raw-events-endpoint.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/integration/raw-events-endpoint.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the auth + supabase clients used by the route.
vi.mock("../../src/lib/api-auth", () => ({
  getAgentOrSessionAuth: vi.fn(async () => ({ userId: "user-1" })),
}));

const rpcCalls: any[] = [];
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (name: string, args: any) => {
      rpcCalls.push({ name, args });
      return {
        data: [{ inserted: args.p_rows.length, updated: 0 }],
        error: null,
      };
    },
  }),
}));

import { POST } from "../../src/app/api/v1/raw_events/route";

function makeReq(body: unknown) {
  return new Request("http://localhost/api/v1/raw_events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/raw_events", () => {
  beforeEach(() => {
    rpcCalls.length = 0;
  });

  it("accepts a valid batch and calls upsert_raw_events", async () => {
    const res = await POST(makeReq([
      {
        source: "whatsapp",
        source_event_id: "wa_1",
        channel: "whatsapp",
        occurred_at: "2026-04-18T12:00:00Z",
      },
    ]) as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accepted).toBe(1);
    expect(rpcCalls[0].name).toBe("upsert_raw_events");
    expect(rpcCalls[0].args.p_user_id).toBe("user-1");
  });

  it("rejects an empty batch", async () => {
    const res = await POST(makeReq([]) as any);
    expect(res.status).toBe(400);
  });

  it("rejects a batch > 500", async () => {
    const big = Array.from({ length: 501 }, (_, i) => ({
      source: "whatsapp",
      source_event_id: `wa_${i}`,
      channel: "whatsapp",
      occurred_at: "2026-04-18T12:00:00Z",
    }));
    const res = await POST(makeReq(big) as any);
    expect(res.status).toBe(400);
  });

  it("returns 401 when not authenticated", async () => {
    const { getAgentOrSessionAuth } = await import("../../src/lib/api-auth");
    (getAgentOrSessionAuth as any).mockResolvedValueOnce(null);
    const res = await POST(makeReq([
      { source: "whatsapp", source_event_id: "wa_x", channel: "whatsapp", occurred_at: "2026-04-18T12:00:00Z" },
    ]) as any);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Implement the route**

```ts
// src/app/api/v1/raw_events/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAgentOrSessionAuth } from "@/lib/api-auth";
import { rawEventsBatchSchema, MAX_BATCH } from "@/lib/raw-events-schema";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  const auth = await getAgentOrSessionAuth(request as any);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = rawEventsBatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid batch",
        details: parsed.error.issues.slice(0, 10),
        max_batch: MAX_BATCH,
      },
      { status: 400 }
    );
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim(),
  );

  const { data, error } = await supabase.rpc("upsert_raw_events", {
    p_user_id: auth.userId,
    p_rows: parsed.data,
  });
  if (error) {
    console.error("[raw_events] rpc error", error);
    return NextResponse.json({ error: "write failed" }, { status: 502 });
  }

  const counts = Array.isArray(data) && data[0] ? data[0] : { inserted: 0, updated: 0 };
  return NextResponse.json({
    ok: true,
    accepted: parsed.data.length,
    inserted: counts.inserted,
    updated: counts.updated,
  });
}
```

- [ ] **Step 3: Run test — expect 4 passed**

```bash
npm run test:integration -- tests/integration/raw-events-endpoint.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/v1/raw_events/route.ts tests/integration/raw-events-endpoint.test.ts
git commit -m "feat(api): POST /api/v1/raw_events with idempotent upsert"
```

---

## Task 5: wacli.db → raw_events bulk importer

**Files:**
- Create: `scripts/import-wacli-to-raw-events.mjs`
- Create: `tests/integration/wacli-to-raw-events.test.js`

- [ ] **Step 1: Write the failing integration test (uses wacli-minimal.db fixture)**

```js
// tests/integration/wacli-to-raw-events.test.js
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { wacliToRawEvents } from "../../scripts/import-wacli-to-raw-events.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("wacliToRawEvents", () => {
  it("maps wacli messages to raw_events shape", () => {
    const db = new Database(
      resolve(__dirname, "..", "fixtures", "wacli-minimal.db"),
      { readonly: true },
    );
    const rows = wacliToRawEvents(db, { connectorVersion: "wacli-import-0.1" });
    expect(rows.length).toBe(50);
    for (const r of rows) {
      expect(r.source).toBe("whatsapp");
      expect(typeof r.source_event_id).toBe("string");
      expect(typeof r.thread_id).toBe("string");
      expect(new Date(r.occurred_at).toString()).not.toBe("Invalid Date");
      expect(["in", "out"]).toContain(r.direction);
      expect(r.connector_version).toBe("wacli-import-0.1");
    }
  });

  it("skips already-seen source_event_ids when a seen set is passed", () => {
    const db = new Database(
      resolve(__dirname, "..", "fixtures", "wacli-minimal.db"),
      { readonly: true },
    );
    const all = wacliToRawEvents(db);
    const seen = new Set(all.slice(0, 10).map((r) => r.source_event_id));
    const remaining = wacliToRawEvents(db, { skipIds: seen });
    expect(remaining).toHaveLength(40);
  });
});
```

- [ ] **Step 2: Implement the importer**

```js
// scripts/import-wacli-to-raw-events.mjs
// Reads wacli.db messages table and produces raw_events rows. When run
// directly, batches and POSTs to /api/v1/raw_events.

const DIRECTION_MAP = { inbound: "in", outbound: "out" };

export function wacliToRawEvents(db, { connectorVersion, skipIds } = {}) {
  const rows = db
    .prepare(
      `SELECT m.id, m.chat_jid, m.sender_jid, m.direction, m.body_preview, m.ts,
              c.is_group, c.name AS chat_name
         FROM messages m
    LEFT JOIN chats c ON c.jid = m.chat_jid
         ORDER BY m.ts`,
    )
    .all();

  const out = [];
  for (const r of rows) {
    if (skipIds && skipIds.has(r.id)) continue;
    const dir = DIRECTION_MAP[r.direction] || null;
    const occurred = new Date(Number(r.ts) * 1000).toISOString();
    const participants = [];
    if (r.sender_jid && r.sender_jid !== "self") {
      participants.push({ jid: r.sender_jid });
    }
    const phone =
      r.sender_jid && /^\d+@s\.whatsapp\.net$/.test(r.sender_jid)
        ? "+" + r.sender_jid.split("@")[0]
        : null;

    out.push({
      source: "whatsapp",
      source_event_id: r.id,
      channel: "whatsapp",
      connector_version: connectorVersion || "wacli-import-0.1",
      occurred_at: occurred,
      direction: dir,
      thread_id: r.chat_jid,
      participants_raw: participants,
      participant_phones: phone ? [phone] : [],
      participant_emails: [],
      body_preview: r.body_preview ? r.body_preview.slice(0, 160) : null,
      attachments_present: false,
      raw_ref: { chat_name: r.chat_name, is_group: Boolean(r.is_group) },
    });
  }
  return out;
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
  if (!res.ok) throw new Error(`POST failed: ${res.status} ${await res.text()}`);
  return res.json();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const Database = (await import("better-sqlite3")).default;
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");

  const dbPath = process.env.WACLI_DB || join(homedir(), ".wacli", "wacli.db");
  const apiUrl = process.env.ORBIT_API_URL || "https://orbit-mu-roan.vercel.app/api/v1";
  const apiKey = process.env.ORBIT_API_KEY;
  if (!apiKey) {
    console.error("ORBIT_API_KEY env required");
    process.exit(2);
  }

  const db = new Database(dbPath, { readonly: true });
  const all = wacliToRawEvents(db);
  console.log(`found ${all.length} rows; posting in batches of 500…`);

  let posted = 0;
  for (let i = 0; i < all.length; i += 500) {
    const chunk = all.slice(i, i + 500);
    const resp = await postBatch(`${apiUrl}/raw_events`, apiKey, chunk);
    posted += resp.inserted || 0;
    console.log(`  batch ${i / 500}: inserted=${resp.inserted} updated=${resp.updated}`);
  }
  console.log(`done: ${posted} new rows (others were idempotent re-upserts)`);
  db.close();
}
```

- [ ] **Step 3: Run test — expect 2 passed**

```bash
npm run test:integration -- tests/integration/wacli-to-raw-events.test.js
```

- [ ] **Step 4: Commit**

```bash
git add scripts/import-wacli-to-raw-events.mjs tests/integration/wacli-to-raw-events.test.js
git commit -m "feat(ingest): wacli.db bulk importer -> raw_events"
```

---

## Task 6: JSONL bootstrap importer

**Files:**
- Create: `scripts/import-jsonl-to-raw-events.mjs`
- Create: `tests/integration/jsonl-to-raw-events.test.js`
- Create: `tests/fixtures/raw-events-sample.jsonl`

- [ ] **Step 1: Create a small JSONL fixture**

```
# tests/fixtures/raw-events-sample.jsonl — 3 lines, one valid + two edge cases
{"source":"gmail","source_event_id":"gmail_abc","channel":"gmail","occurred_at":"2026-04-18T09:00:00Z","thread_id":"t1","participant_emails":["alice@example.com"]}
{"source":"calendar","source_event_id":"cal_123","channel":"calendar","occurred_at":"2026-04-18T10:00:00Z"}
{"source":"slack","source_event_id":"slack_xyz","channel":"slack","occurred_at":"bad-date"}
```

- [ ] **Step 2: Write the failing test**

```js
// tests/integration/jsonl-to-raw-events.test.js
import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonl } from "../../scripts/import-jsonl-to-raw-events.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("readJsonl", () => {
  it("returns valid rows and collects validation errors for invalid ones", async () => {
    const path = resolve(__dirname, "..", "fixtures", "raw-events-sample.jsonl");
    const { valid, invalid } = await readJsonl(path);
    expect(valid).toHaveLength(2);
    expect(invalid).toHaveLength(1);
    expect(invalid[0].error).toMatch(/occurred_at/);
  });
});
```

- [ ] **Step 3: Implement**

```js
// scripts/import-jsonl-to-raw-events.mjs
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { rawEventSchema } from "../src/lib/raw-events-schema.ts"; // vitest handles TS transform

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
      invalid.push({ line_no, error: result.error.issues.map((i) => i.path.join(".")).join(",") });
    }
  }
  return { valid, invalid };
}

// CLI — node scripts/import-jsonl-to-raw-events.mjs <file.jsonl>
if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node import-jsonl-to-raw-events.mjs <file.jsonl>");
    process.exit(2);
  }
  const { valid, invalid } = await readJsonl(path);
  console.log(`valid=${valid.length} invalid=${invalid.length}`);
  if (invalid.length) {
    for (const err of invalid.slice(0, 10)) console.log(`  line ${err.line_no}: ${err.error}`);
  }
  // POST in batches of 500
  const apiUrl = process.env.ORBIT_API_URL || "https://orbit-mu-roan.vercel.app/api/v1";
  const apiKey = process.env.ORBIT_API_KEY;
  if (apiKey) {
    for (let i = 0; i < valid.length; i += 500) {
      const chunk = valid.slice(i, i + 500);
      const res = await fetch(`${apiUrl}/raw_events`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(chunk),
      });
      console.log(`batch ${i / 500}: ${res.status}`);
    }
  }
}
```

- [ ] **Step 4: Run test — expect 1 passed**

```bash
npm run test:integration -- tests/integration/jsonl-to-raw-events.test.js
```

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/raw-events-sample.jsonl \
        scripts/import-jsonl-to-raw-events.mjs \
        tests/integration/jsonl-to-raw-events.test.js
git commit -m "feat(ingest): JSONL bootstrap importer -> raw_events"
```

---

## Task 7: Full-suite dry run + verification log

- [ ] **Step 1: Run everything**

```bash
npm test 2>&1 | tee outputs/verification/2026-04-18-track2/npm-test.log
```

- [ ] **Step 2: Update verification log**

Append to `outputs/verification-log.md`:

```
2026-04-18 HH:MM  TRACK=2  CLAIM="raw_events ledger + idempotent endpoint + two importers landed"
  evidence: outputs/verification/2026-04-18-track2/npm-test.log
  method:   npm test (vitest)
  result:   PASS — <N> tests total; migration applied to branch DB
  commit:   <sha>
  deferred: production Supabase apply; live wacli bulk import of 33k rows
```

- [ ] **Step 3: Commit**

---

## Exit gate

Track 2 is "done" when:

1. `npm test` exits 0 with all tests green
2. Migrations applied to production Supabase (or explicit deferral logged)
3. `scripts/import-wacli-to-raw-events.mjs` can read wacli-minimal.db fixture without errors (unit test covers this)
4. `outputs/verification-log.md` has a Track=2 row
