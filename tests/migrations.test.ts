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

  it("ranks backups by time, not by name, once a version number has two digits", async () => {
    const { pruneBackups } = await import("@/lib/db");
    const dir = fs.mkdtempSync(path.join(process.env.DATA_DIR!, "mixed-"));
    fs.writeFileSync(path.join(dir, "keep-me.db"), "not ours");
    const names = [5, 6, 7, 8, 9, 10].map((v, i) => `sproutwall-v${v}-to-v${v + 1}-2026111${i}T120000000Z-00.db`);
    for (const n of names) fs.writeFileSync(path.join(dir, n), "");
    pruneBackups(dir, 5);
    const left = fs.readdirSync(dir).filter((f) => BACKUP_NAME.test(f));
    expect(left.sort()).toEqual(names.slice(1).sort());
    expect(left).toContain("sproutwall-v10-to-v11-20261115T120000000Z-00.db");
    expect(fs.existsSync(path.join(dir, "keep-me.db"))).toBe(true);
  });

  it("fails without touching existing backups when every name for this moment is taken", async () => {
    const file = useDbFile("full");
    const { getDb, createBackup, isDbBlocked } = await import("@/lib/db");
    const db = getDb();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-18T12:00:00.000Z"));
    try {
      const dir = path.join(path.dirname(file), "backups");
      fs.mkdirSync(dir, { recursive: true });
      for (let n = 0; n < 100; n++) {
        fs.writeFileSync(path.join(dir, `sproutwall-v1-to-v2-20261118T120000000Z-${String(n).padStart(2, "0")}.db`), `kept ${n}`);
      }
      let err: unknown;
      try {
        createBackup(db, file, 1, 2);
      } catch (e) {
        err = e;
      }
      expect(isDbBlocked(err) && err.code).toBe("backup_failed");
      expect(fs.readdirSync(dir)).toHaveLength(100);
      expect(fs.readFileSync(path.join(dir, "sproutwall-v1-to-v2-20261118T120000000Z-99.db"), "utf8")).toBe("kept 99");
    } finally {
      vi.useRealTimers();
    }
  });

  it("remembers a blocked state for a minute, then tries again by itself", async () => {
    const file = useDbFile("retry");
    fs.copyFileSync(FIXTURE, file);
    const obstacle = path.join(path.dirname(file), "backups");
    fs.writeFileSync(obstacle, "in the way");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-18T12:00:00.000Z"));
    try {
      const { GET } = await import("@/app/api/health/route");
      const { BLOCKED_RETRY_MS } = await import("@/lib/db");
      expect(GET().status).toBe(503);
      fs.rmSync(obstacle);
      expect(GET().status).toBe(503);
      expect(fs.existsSync(obstacle)).toBe(false);
      vi.setSystemTime(Date.now() + BLOCKED_RETRY_MS + 1);
      expect(GET().status).toBe(200);
      expect(backups(file)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a database that becomes newer while this build opens it", () => {
  it("is refused before any write, even after the read-only check passed", async () => {
    const file = useDbFile("race");
    fs.copyFileSync(FIXTURE, file);
    const { initializeDb, isDbBlocked } = await import("@/lib/db");
    // The read-only check in createDb saw version 0. Now a newer build
    // upgrades the file before this build writes anything.
    const other = new Database(file);
    other.pragma("user_version = 999");
    other.close();
    const before = fingerprint(file);
    const db = new Database(file);
    let err: unknown;
    try {
      initializeDb(db, file);
    } catch (e) {
      err = e;
    } finally {
      db.close();
    }
    expect(isDbBlocked(err) && err.code).toBe("db_newer_than_app");
    expect(fingerprint(file)).toBe(before);
    expect(backups(file)).toEqual([]);
  });

  it("setup and PIN answer 503 with the code instead of failing", async () => {
    const file = useDbFile("blocked-bootstrap");
    fs.copyFileSync(FIXTURE, file);
    const raw = new Database(file);
    raw.pragma("user_version = 999");
    raw.close();
    const { NextRequest } = await import("next/server");
    const post = (url: string, body: unknown) =>
      new NextRequest(url, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://hub.home", host: "hub.home" },
        body: JSON.stringify(body),
      });
    const setup = await import("@/app/api/setup/route");
    const pin = await import("@/app/api/pin/route");
    for (const res of [
      await setup.POST(post("http://hub.home/api/setup", { pin: "7319" })),
      await pin.POST(post("http://hub.home/api/pin", { pin: "7319" })),
    ]) {
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: "db_newer_than_app" });
    }
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

describe("proxy in the blocked state", () => {
  it("answers API calls with 503 and the code, and lets pages and health through", async () => {
    const file = useDbFile("proxy-blocked");
    fs.copyFileSync(FIXTURE, file);
    const raw = new Database(file);
    raw.pragma("user_version = 999");
    raw.close();
    const { proxy } = await import("@/proxy");
    const { NextRequest } = await import("next/server");
    const get = (p: string) => proxy(new NextRequest(`http://hub.home${p}`));

    const api = get("/api/today");
    expect(api.status).toBe(503);
    expect(await api.json()).toMatchObject({ code: "db_newer_than_app" });
    // NextResponse.next() carries this header; the page then renders BlockedScreen.
    expect(get("/today").headers.get("x-middleware-next")).toBe("1");
    expect(get("/api/health").headers.get("x-middleware-next")).toBe("1");
    expect(userVersion(file)).toBe(999);
  });
});
