import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..", "..");
const sql = readFileSync(
  resolve(REPO, "supabase/migrations/20260418_upsert_raw_events_rpc.sql"),
  "utf8",
);

describe("upsert_raw_events RPC SQL", () => {
  it("uses plpgsql FOUND — not RETURNING-into — to count inserts", () => {
    // Regression guard: `returning true into v_was_insert` combined with
    // `on conflict do nothing` does NOT assign on a swallowed conflict,
    // so the variable keeps its prior value and inserts get miscounted.
    expect(sql).toMatch(/if\s+FOUND\s+then/i);
    expect(sql).not.toMatch(/returning\s+true\s+into/i);
  });

  it("declares SECURITY DEFINER + sets search_path", () => {
    expect(sql).toMatch(/security\s+definer/i);
    expect(sql).toMatch(/set\s+search_path\s*=\s*public/i);
  });

  it("on-conflict target matches the unique constraint", () => {
    expect(sql).toMatch(
      /on\s+conflict\s*\(\s*user_id\s*,\s*source\s*,\s*source_event_id\s*\)/i,
    );
  });

  it("grants execute to anon + authenticated + service_role", () => {
    expect(sql).toMatch(/grant\s+execute[\s\S]+to\s+anon\s*,\s*authenticated\s*,\s*service_role/i);
  });

  it("revokes from public before granting", () => {
    const revokeIdx = sql.search(/revoke\s+all\s+on\s+function/i);
    const grantIdx = sql.search(/grant\s+execute\s+on\s+function/i);
    expect(revokeIdx).toBeGreaterThan(-1);
    expect(grantIdx).toBeGreaterThan(-1);
    expect(revokeIdx).toBeLessThan(grantIdx);
  });
});
