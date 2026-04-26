import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..", "..");
const sql = [
  "20260426_hermes_observation_writes.sql",
  "20260426_hermes_card_rows.sql",
  "20260426_hermes_fold_person_cards.sql",
  "20260426_hermes_enriched_search.sql",
]
  .map((file) =>
    readFileSync(resolve(REPO, "supabase/migrations", file), "utf8"),
  )
  .join("\n");

describe("Hermes write API SQL", () => {
  it("extends observations to support note kind", () => {
    expect(sql).toMatch(/kind\s+in\s*\([^)]*'note'/i);
  });

  it("autolinks targeted interaction and note observations", () => {
    expect(sql).toMatch(/v_kind\s+in\s*\([^)]*'interaction'[^)]*'note'[^)]*\)/i);
    expect(sql).toMatch(/target_person_id/i);
    expect(sql).toMatch(/person_observation_links/i);
  });

  it("declares SECURITY DEFINER functions with explicit search_path", () => {
    expect(sql).toMatch(/function\s+public\.upsert_observations[\s\S]+security\s+definer/i);
    expect(sql).toMatch(/function\s+public\.select_enriched_persons[\s\S]+security\s+definer/i);
    expect(sql).toMatch(/function\s+public\.search_persons[\s\S]+security\s+definer/i);
    expect(sql).toMatch(/set\s+search_path\s*=\s*public/i);
  });

  it("grants RPC execute to API roles", () => {
    expect(sql).toMatch(/grant\s+execute[\s\S]+upsert_observations[\s\S]+anon\s*,\s*authenticated\s*,\s*service_role/i);
    expect(sql).toMatch(/grant\s+execute[\s\S]+search_persons[\s\S]+anon\s*,\s*authenticated\s*,\s*service_role/i);
  });

  it("adds Hermes enriched fields to folded and enriched person output", () => {
    expect(sql).toMatch(/relationship_strength\s+text/i);
    expect(sql).toMatch(/last_activity\s+jsonb/i);
    expect(sql).toMatch(/activity_count\s+integer/i);
  });
});
