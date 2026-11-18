import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const FIXTURE = path.resolve(__dirname, "fixtures/db-da1ecc2.db");
const BACKUP_NAME = /^sproutwall-v\d+-to-v\d+-\d{8}T\d{9}Z-\d{2}\.db$/;

// Each test gets its own folder, so backups from one test never show up in another.
function useDbFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(process.env.DATA_DIR!, `${name}-`));
  const file = path.join(dir, "family-hub.db");
  process.env.FAMILY_HUB_DB = file;
  return file;
}

function closeCachedDb() {
  globalThis.__familyHubDb?.close();
  globalThis.__familyHubDb = undefined;
}

function backups(file: string): string[] {
  const dir = path.join(path.dirname(file), "backups");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => BACKUP_NAME.test(f)).sort() : [];
}

function fingerprint(file: string): string {
  if (!fs.existsSync(file)) return "absent";
  const st = fs.statSync(file);
  return `${st.size}:${st.mtimeMs}:${crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
}

function userVersion(file: string): number {
  const ro = new Database(file, { readonly: true });
  try {
    return ro.pragma("user_version", { simple: true }) as number;
  } finally {
    ro.close();
  }
}

beforeEach(() => {
  closeCachedDb();
  vi.resetModules();
});

describe("schema versioning", () => {
  it("a fresh database ends at the latest schema, with the sample family and no backup", async () => {
    const file = useDbFile("fresh");
    const { getDb } = await import("@/lib/db");
    const { LATEST_SCHEMA } = await import("@/lib/migrations");
    const db = getDb();
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA);
    expect((db.prepare("SELECT COUNT(*) c FROM members").get() as { c: number }).c).toBe(5);
    expect(backups(file)).toEqual([]);
  });

  it("opening the same database again changes nothing and makes no backup", async () => {
    const file = useDbFile("twice");
    const counts = (db: Database.Database) =>
      ["members", "ledger", "rewards", "task_box", "activities", "lists", "checklist_templates"].map(
        (t) => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c
      );
    const first = await import("@/lib/db");
    const before = counts(first.getDb());
    closeCachedDb();
    vi.resetModules();
    const second = await import("@/lib/db");
    expect(counts(second.getDb())).toEqual(before);
    expect(backups(file)).toEqual([]);
  });

  it("upgrades a database from before versioning (da1ecc2), keeps its data and backs it up first", async () => {
    const file = useDbFile("old");
    fs.copyFileSync(FIXTURE, file);
    const { getDb } = await import("@/lib/db");
    const { LATEST_SCHEMA } = await import("@/lib/migrations");
    const db = getDb();
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA);
    const marker = db.prepare("SELECT amount FROM ledger WHERE label='Fixture marker'").get() as { amount: number };
    expect(marker.amount).toBe(7);
    expect((db.prepare("SELECT COUNT(*) c FROM ledger").get() as { c: number }).c).toBe(6);
    expect((db.prepare("SELECT COUNT(*) c FROM members").get() as { c: number }).c).toBe(5);
    const made = backups(file);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatch(new RegExp(`^sproutwall-v0-to-v${LATEST_SCHEMA}-`));
    const copy = path.join(path.dirname(file), "backups", made[0]);
    expect(userVersion(copy)).toBe(0);
    const c = new Database(copy, { readonly: true });
    expect((c.prepare("SELECT COUNT(*) c FROM ledger").get() as { c: number }).c).toBe(6);
    c.close();
  });

  it("refuses a database from a newer version, answers 503, and leaves the files untouched", async () => {
    const file = useDbFile("newer");
    fs.copyFileSync(FIXTURE, file);
    const raw = new Database(file);
    raw.pragma("journal_mode = WAL");
    raw.pragma("user_version = 999");
    raw.close();
    const before = [fingerprint(file), fingerprint(`${file}-wal`)];

    const { getDb, isDbBlocked } = await import("@/lib/db");
    let err: unknown;
    try {
      getDb();
    } catch (e) {
      err = e;
    }
    expect(isDbBlocked(err) && err.code).toBe("db_newer_than_app");

    const { GET } = await import("@/app/api/health/route");
    const res = GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, code: "db_newer_than_app", db: 999 });

    expect(fingerprint(file)).toBe(before[0]);
    // A read-only open may create an empty -wal/-shm pair; it must never add data.
    const walAfter = fingerprint(`${file}-wal`);
    if (before[1] === "absent") expect(walAfter === "absent" || walAfter.startsWith("0:")).toBe(true);
    else expect(walAfter).toBe(before[1]);
    expect(userVersion(file)).toBe(999);
    expect(backups(file)).toEqual([]);
  });

  it("blocks instead of migrating when the backup can't be made", async () => {
    const file = useDbFile("nobackup");
    fs.copyFileSync(FIXTURE, file);
    // A plain file where the backups folder should go makes the copy impossible.
    fs.writeFileSync(path.join(path.dirname(file), "backups"), "in the way");

    const { GET } = await import("@/app/api/health/route");
    const res = GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, code: "backup_failed" });
    expect(userVersion(file)).toBe(0);
  });

  it("keeps only the newest five backups and never deletes other files", async () => {
    const file = useDbFile("retention");
    const { getDb, createBackup, pruneBackups, BACKUPS_KEPT } = await import("@/lib/db");
    const db = getDb();
    const dir = path.join(path.dirname(file), "backups");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "keep-me.db"), "not ours");
    const made: string[] = [];
    for (let i = 0; i < 7; i++) made.push(path.basename(createBackup(db, file, 1, 2)));
    pruneBackups(dir, BACKUPS_KEPT);
    expect(BACKUPS_KEPT).toBe(5);
    expect(backups(file)).toEqual([...made].sort().slice(-5));
    expect(backups(file)).toContain(made[made.length - 1]);
    expect(fs.existsSync(path.join(dir, "keep-me.db"))).toBe(true);
  });
});

describe("health check", () => {
  it("reports only ok, the app version and the schema", async () => {
    useDbFile("health");
    const { GET } = await import("@/app/api/health/route");
    const { LATEST_SCHEMA } = await import("@/lib/migrations");
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"));
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: pkg.version, schema: LATEST_SCHEMA });
  });
});
