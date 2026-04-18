import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { importGroupParticipants } from "../../scripts/import-group-participants.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
    const g1 = fake.calls.find(
      (c) => c.params.groupJid === "120363000000000001@g.us",
    );
    expect(g1).toBeDefined();
    expect(g1.params.memberIds).toHaveLength(6);
  });

  it("does not emit for groups with <2 members", async () => {
    const emptyDb = new Database(":memory:");
    emptyDb
      .prepare("CREATE TABLE group_participants (group_jid TEXT, user_jid TEXT, role TEXT, updated_at INTEGER)")
      .run();
    emptyDb
      .prepare("INSERT INTO group_participants VALUES ('g1@g.us','alice@wa','member',0)")
      .run();
    const fake = makeFakeNeo4j();
    const result = await importGroupParticipants({
      db: emptyDb,
      runCypher: fake.runCypher,
    });
    expect(result.groups_processed).toBe(0);
    expect(fake.calls.length).toBe(0);
  });

  it("assigns CO_PRESENT_IN edges with weight 0.1 in Cypher", async () => {
    const db = new Database(fixture, { readonly: true });
    const fake = makeFakeNeo4j();
    await importGroupParticipants({ db, runCypher: fake.runCypher });
    expect(fake.calls[0].cypher).toMatch(/CO_PRESENT_IN/);
    expect(fake.calls[0].cypher).toMatch(/r\.weight\s*=\s*0\.1/);
  });
});
