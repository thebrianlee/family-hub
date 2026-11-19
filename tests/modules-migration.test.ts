import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Migration 0002 (module_state). Each test opens its own database file.

const FIXTURE = path.resolve(__dirname, "fixtures/db-da1ecc2.db");

function useDbFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(process.env.DATA_DIR!, `${name}-`));
  const file = path.join(dir, "sproutwall.db");
  process.env.SPROUTWALL_DB = file;
  return file;
}

function closeCachedDb() {
  globalThis.__sproutwallDb?.close();
  globalThis.__sproutwallDb = undefined;
}

/** The da1ecc2 fixture, marked as a household that finished setup. */
function setUpFixture(file: string) {
  fs.copyFileSync(FIXTURE, file);
  const raw = new Database(file);
  raw.prepare("UPDATE settings SET value='1' WHERE key='setup_complete'").run();
  raw.close();
}

function rows(db: Database.Database) {
  return db.prepare("SELECT id, enabled, updated_at FROM module_state ORDER BY id").all() as {
    id: string;
    enabled: number;
    updated_at: string;
  }[];
}

beforeEach(() => {
  closeCachedDb();
  vi.resetModules();
});

describe("migration 0002-module-state", () => {
  it("is the last migration, so the schema is 2", async () => {
    const { MIGRATIONS, LATEST_SCHEMA } = await import("@/lib/migrations");
    expect(MIGRATIONS.map((m) => [m.id, m.name])).toEqual([
      [1, "baseline"],
      [2, "module-state"],
    ]);
    expect(LATEST_SCHEMA).toBe(2);
  });

  it("an existing household that finished setup gets every module on, Ask included", async () => {
    const file = useDbFile("existing");
    setUpFixture(file);
    const { getDb } = await import("@/lib/db");
    const { enabledModules, isEnabled } = await import("@/lib/modules");
    const db = getDb();
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    expect(rows(db).map((r) => [r.id, r.enabled])).toEqual(
      ["ask", "calendar", "lists", "meals", "progress", "reading", "rewards", "routines"].map((id) => [id, 1])
    );
    expect(enabledModules()).toEqual(["core", "calendar", "routines", "rewards", "progress", "reading", "meals", "lists", "ask"]);
    expect(isEnabled("ask")).toBe(true);
    // The household's data is still there.
    const marker = db.prepare("SELECT amount FROM ledger WHERE label='Fixture marker'").get() as { amount: number };
    expect(marker.amount).toBe(7);
    expect(fs.readdirSync(path.join(path.dirname(file), "backups"))).toHaveLength(1);
  });

  it("an old database that never finished setup gets no rows (setup writes them)", async () => {
    const file = useDbFile("old-not-set-up");
    fs.copyFileSync(FIXTURE, file);
    const { getDb } = await import("@/lib/db");
    expect(rows(getDb())).toEqual([]);
  });

  it("a fresh database gets the table and no rows, so the defaults apply", async () => {
    useDbFile("fresh");
    const { getDb } = await import("@/lib/db");
    const { isEnabled, enabledModules } = await import("@/lib/modules");
    expect(rows(getDb())).toEqual([]);
    expect(isEnabled("ask")).toBe(false);
    expect(isEnabled("lists")).toBe(true);
    expect(enabledModules()).not.toContain("ask");
  });

  it("running the step twice changes nothing", async () => {
    const file = useDbFile("twice");
    setUpFixture(file);
    const { getDb } = await import("@/lib/db");
    const { moduleState } = await import("@/lib/migrations/0002-module-state");
    const db = getDb();
    db.prepare("UPDATE module_state SET enabled=0, updated_at='2026-01-01 00:00:00' WHERE id='lists'").run();
    const before = rows(db);
    moduleState.up(db);
    moduleState.up(db);
    expect(rows(db)).toEqual(before);
  });

  it("leaves a row it doesn't know alone, and the app ignores it", async () => {
    const file = useDbFile("unknown");
    setUpFixture(file);
    const raw = new Database(file);
    raw.exec(
      "CREATE TABLE module_state (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK (enabled IN (0,1)), updated_at TEXT NOT NULL DEFAULT (datetime('now')))"
    );
    raw.prepare("INSERT INTO module_state (id, enabled) VALUES ('from-a-newer-version', 1), ('lists', 0)").run();
    raw.close();
    const { getDb } = await import("@/lib/db");
    const { enabledModules, setEnabled } = await import("@/lib/modules");
    const db = getDb();
    const ids = rows(db).map((r) => [r.id, r.enabled]);
    expect(ids).toContainEqual(["from-a-newer-version", 1]);
    // INSERT OR IGNORE: an existing row keeps its value.
    expect(ids).toContainEqual(["lists", 0]);
    expect(enabledModules()).not.toContain("from-a-newer-version");
    setEnabled({ lists: true }, { actor: "parent" });
    expect(rows(db).map((r) => r.id)).toContain("from-a-newer-version");
  });
});
