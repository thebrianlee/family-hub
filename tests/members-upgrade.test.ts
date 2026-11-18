import Database from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("an install from before the members table", () => {
  it("gets the five sample members, so its existing data stays valid", async () => {
    // An older database: already seeded and set up, no members table.
    const file = path.join(process.env.DATA_DIR!, "old.db");
    const old = new Database(file);
    old.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO settings (key, value) VALUES ('seeded','1'), ('setup_complete','1'), ('buckets_migrated','1');
      CREATE TABLE ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, kid TEXT NOT NULL, amount INTEGER NOT NULL,
        source TEXT NOT NULL, label TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
      INSERT INTO ledger (kid, amount, source, label) VALUES ('quinn', 12, 'myday', 'Checklist');
    `);
    old.close();
    process.env.SPROUTWALL_DB = file;

    const { getMembers, isKidId } = await import("@/lib/household");
    const { getBalances } = await import("@/lib/queries");
    expect(getMembers().map((m) => [m.id, m.name, m.color])).toEqual([
      ["riley", "Riley", "#6E9BBD"],
      ["quinn", "Quinn", "#7FA576"],
      ["sam", "Sam", "#D9A254"],
      ["avery", "Avery", "#5E7B86"],
      ["jordan", "Jordan", "#8A6D9E"],
    ]);
    expect(isKidId("quinn")).toBe(true);
    expect(getBalances().kids.find((k) => k.kid === "quinn")?.balance).toBe(12);
  });
});
