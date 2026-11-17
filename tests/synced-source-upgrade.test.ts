import Database from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("an install from before synced_events.source", () => {
  it("gets the column, with NULL on its old rows, and running the migration again changes nothing", async () => {
    const file = path.join(process.env.DATA_DIR!, "old-synced.db");
    const old = new Database(file);
    old.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO settings (key, value) VALUES ('seeded','1'), ('setup_complete','1'), ('buckets_migrated','1');
      CREATE TABLE synced_events (
        id TEXT PRIMARY KEY, member TEXT NOT NULL, title TEXT NOT NULL, date TEXT NOT NULL,
        start TEXT, end TEXT, location TEXT,
        fetched_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      INSERT INTO synced_events (id, member, title, date) VALUES ('shared:swim@test:riley', 'riley', 'Swim', '2026-12-01');
    `);
    old.close();
    process.env.FAMILY_HUB_DB = file;

    const { getDb } = await import("@/lib/db");
    const columns = () => (getDb().prepare("PRAGMA table_info(synced_events)").all() as { name: string }[]).map((c) => c.name);
    expect(columns()).toContain("source");
    expect(getDb().prepare("SELECT id, source FROM synced_events").all()).toEqual([
      { id: "shared:swim@test:riley", source: null },
    ]);

    // A second start runs the same migration on the upgraded file.
    getDb().close();
    globalThis.__familyHubDb = undefined;
    expect(columns().filter((c) => c === "source")).toHaveLength(1);
  });
});
