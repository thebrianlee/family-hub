import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DB_FILE, LEGACY_DB_FILE, resolveDbPath } from "../scripts/lib/db-path.mjs";

const FIXTURE = path.resolve(__dirname, "fixtures/db-da1ecc2.db");
const RESET_PIN = path.resolve(__dirname, "../scripts/reset-pin.mjs");

function freshDir(name: string): string {
  return fs.mkdtempSync(path.join(process.env.DATA_DIR!, `${name}-`));
}

function touch(file: string) {
  fs.writeFileSync(file, "");
}

describe("resolveDbPath: which database file to open", () => {
  it("creates sproutwall.db in a fresh data folder", () => {
    const dataDir = freshDir("fresh");
    expect(resolveDbPath({ dataDir, env: {} })).toEqual({ file: path.join(dataDir, DB_FILE), source: "new", warnings: [] });
  });

  it("keeps opening family-hub.db on an install from before the rename (Docker sets only DATA_DIR)", () => {
    const dataDir = freshDir("legacy");
    touch(path.join(dataDir, LEGACY_DB_FILE));
    expect(resolveDbPath({ dataDir, env: { DATA_DIR: dataDir } })).toEqual({
      file: path.join(dataDir, LEGACY_DB_FILE),
      source: "legacy",
      warnings: [],
    });
  });

  it("prefers sproutwall.db when both files are present, and says so", () => {
    const dataDir = freshDir("both");
    touch(path.join(dataDir, DB_FILE));
    touch(path.join(dataDir, LEGACY_DB_FILE));
    const r = resolveDbPath({ dataDir, env: {} });
    expect(r.file).toBe(path.join(dataDir, DB_FILE));
    expect(r.source).toBe("existing");
    expect(r.warnings).toHaveLength(1);
  });

  it("honours SPROUTWALL_DB first, then the deprecated FAMILY_HUB_DB with a notice", () => {
    const dataDir = freshDir("env");
    const a = path.join(dataDir, "a.db");
    const b = path.join(dataDir, "b.db");
    expect(resolveDbPath({ dataDir, env: { SPROUTWALL_DB: a, FAMILY_HUB_DB: b } })).toEqual({
      file: a,
      source: "SPROUTWALL_DB",
      warnings: [],
    });
    const legacy = resolveDbPath({ dataDir, env: { FAMILY_HUB_DB: b } });
    expect(legacy.file).toBe(b);
    expect(legacy.source).toBe("FAMILY_HUB_DB");
    expect(legacy.warnings.join(" ")).toMatch(/deprecated/);
  });

  it("resolves a relative env path against the given base folder", () => {
    const dataDir = freshDir("relative");
    expect(resolveDbPath({ dataDir, env: { SPROUTWALL_DB: "x/hub.db" }, base: dataDir }).file).toBe(
      path.join(dataDir, "x/hub.db")
    );
  });

  it("warns when an env path is missing but family-hub.db sits next to it", () => {
    const dataDir = freshDir("missing");
    touch(path.join(dataDir, LEGACY_DB_FILE));
    const r = resolveDbPath({ dataDir, env: { SPROUTWALL_DB: path.join(dataDir, DB_FILE) } });
    expect(r.file).toBe(path.join(dataDir, DB_FILE));
    expect(r.warnings).toHaveLength(1);
  });

  it("never puts a full path in a warning", () => {
    const dataDir = freshDir("redact");
    touch(path.join(dataDir, DB_FILE));
    touch(path.join(dataDir, LEGACY_DB_FILE));
    const all = [
      ...resolveDbPath({ dataDir, env: {} }).warnings,
      ...resolveDbPath({ dataDir, env: { FAMILY_HUB_DB: path.join(dataDir, "nope.db") } }).warnings,
    ];
    expect(all.length).toBeGreaterThan(0);
    for (const w of all) expect(w).not.toContain(dataDir);
  });
});

describe("an install from before the rename", () => {
  const saved = process.env.DATA_DIR;

  beforeEach(() => {
    globalThis.__sproutwallDb?.close();
    globalThis.__sproutwallDb = undefined;
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.__sproutwallDb?.close();
    globalThis.__sproutwallDb = undefined;
    process.env.DATA_DIR = saved;
  });

  it("the app and reset-pin both open the old family-hub.db and keep the household", async () => {
    const dataDir = freshDir("upgrade");
    const legacy = path.join(dataDir, LEGACY_DB_FILE);
    fs.copyFileSync(FIXTURE, legacy);
    process.env.DATA_DIR = dataDir;
    delete process.env.SPROUTWALL_DB;
    delete process.env.FAMILY_HUB_DB;

    const { getDb } = await import("@/lib/db");
    const db = getDb();
    expect(db.name).toBe(legacy);
    const marker = db.prepare("SELECT amount FROM ledger WHERE label='Fixture marker'").get() as { amount: number };
    expect(marker.amount).toBe(7);
    expect(fs.existsSync(path.join(dataDir, DB_FILE))).toBe(false);
    globalThis.__sproutwallDb?.close();
    globalThis.__sproutwallDb = undefined;

    const out = execFileSync(process.execPath, [RESET_PIN, "4827"], {
      env: { ...process.env, DATA_DIR: dataDir },
      encoding: "utf8",
      stdio: "pipe",
    });
    expect(out).toContain("Parent PIN reset");
    const check = new Database(legacy, { readonly: true });
    const pin = check.prepare("SELECT value FROM settings WHERE key='parent_pin'").get() as { value: string };
    check.close();
    expect(pin.value).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/);
    expect(fs.existsSync(path.join(dataDir, DB_FILE))).toBe(false);
  });
});
