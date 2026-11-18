import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { dataDir } from "./paths";
import { LATEST_SCHEMA, MIGRATIONS } from "./migrations";
import { resolveDbPath } from "../../scripts/lib/db-path.mjs";

// Which file: SPROUTWALL_DB, then FAMILY_HUB_DB, then sproutwall.db or (from
// before the rename) family-hub.db in the data folder. The host scripts use the
// same resolver, so the app and `reset-pin` always open the same file.
const RESOLVED = resolveDbPath({ dataDir: dataDir() });
const DB_PATH = RESOLVED.file;

// Singleton SQLite handle. Survives Next.js dev-server hot reloads via globalThis.
declare global {
  var __sproutwallDb: Database.Database | undefined;
}

export type DbBlockedCode = "db_newer_than_app" | "backup_failed" | "low_disk";

/**
 * The app must not use the database right now. Every route that opens it fails
 * with this; the screen shows a message instead of the app and /api/health
 * answers 503 with the code. Nothing writes household data in this state.
 * - db_newer_than_app: the data was written by a newer build (user_version is
 *   higher than any migration this build knows). Update or restore a backup.
 * - low_disk / backup_failed: an upgrade is pending but the safety copy could
 *   not be made, so the schema is left as it was.
 */
export class DbBlockedError extends Error {
  constructor(
    readonly code: DbBlockedCode,
    message: string,
    readonly details: Record<string, number> = {}
  ) {
    super(message);
    this.name = "DbBlockedError";
  }
}

export function isDbBlocked(e: unknown): e is DbBlockedError {
  return e instanceof DbBlockedError || (e instanceof Error && e.name === "DbBlockedError");
}

/** user_version of an existing database file, read through a read-only handle. */
function readSchemaVersion(file: string): number | null {
  if (!fs.existsSync(file)) return null;
  const ro = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return ro.pragma("user_version", { simple: true }) as number;
  } finally {
    ro.close();
  }
}

function createDb(): Database.Database {
  for (const warning of RESOLVED.warnings) console.warn(`[db] ${warning}`);
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  // Check the version through a read-only handle first, so a database written
  // by a newer build is never opened for writing (not even the WAL switch).
  const version = readSchemaVersion(DB_PATH);
  if (version !== null && version > LATEST_SCHEMA) {
    console.error(
      `[db] ${DB_PATH} has schema ${version}, newer than this app's ${LATEST_SCHEMA}. ` +
        "Not opening it. Update the app, or restore a backup."
    );
    throw new DbBlockedError(
      "db_newer_than_app",
      `The database (schema ${version}) was written by a newer version of this app (schema ${LATEST_SCHEMA}).`,
      { db: version, app: LATEST_SCHEMA }
    );
  }
  const db = new Database(DB_PATH);
  try {
    initializeDb(db, DB_PATH);
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

/**
 * Everything after the file is open for writing. Exported for tests only.
 *
 * Another process (a newer build) may upgrade the file between the read-only
 * check above and this point. So the version is checked again on this handle
 * before the first write, inside every migration step, and inside the write
 * transaction that seeds the defaults, so a newer database is never written.
 */
export function initializeDb(db: Database.Database, file: string): void {
  assertNotNewer(db, file);
  // WAL is a persistent property of the file, and every Sproutwall build uses
  // it. So switch only a file that is not in WAL yet: a database that a newer
  // build has upgraded is already WAL, and this build issues no write to it at
  // all. (Changing the journal mode can't share a transaction with the version
  // check; SQLite forbids it.) The version is checked again right after.
  const mode = String(db.pragma("journal_mode", { simple: true })).toLowerCase();
  if (mode !== "wal") db.pragma("journal_mode = WAL");
  assertNotNewer(db, file);
  runMigrations(db, file);
  db.transaction(() => {
    assertNotNewer(db, file);
    seedDefaults(db);
    seed(db);
  }).immediate();
  applyHouseholdTimezone(db);
}

/** Refuse a database whose schema is newer than this build (see createDb). */
function assertNotNewer(db: Database.Database, file: string): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version <= LATEST_SCHEMA) return;
  console.error(
    `[db] ${file} has schema ${version}, newer than this app's ${LATEST_SCHEMA}. ` +
      "Not using it. Update the app, or restore a backup."
  );
  throw new DbBlockedError(
    "db_newer_than_app",
    `The database (schema ${version}) was written by a newer version of this app (schema ${LATEST_SCHEMA}).`,
    { db: version, app: LATEST_SCHEMA }
  );
}

/**
 * Bring the schema up to LATEST_SCHEMA. Before changing a database that already
 * holds data, make a verified copy in backups/ next to the database file; if
 * that isn't possible, leave the schema alone and block (DbBlockedError).
 * Old copies are pruned only after every migration has succeeded.
 */
function runMigrations(db: Database.Database, file: string) {
  assertNotNewer(db, file);
  const current = db.pragma("user_version", { simple: true }) as number;
  if (!MIGRATIONS.some((m) => m.id > current)) return;
  const backup = isFresh(db) ? null : createBackup(db, file, current, LATEST_SCHEMA);
  for (const m of MIGRATIONS) {
    // BEGIN IMMEDIATE takes the write lock first; re-reading the version
    // inside it means a second process that got here too can't run it twice.
    db.transaction(() => {
      assertNotNewer(db, file);
      const now = db.pragma("user_version", { simple: true }) as number;
      if (now >= m.id) return;
      m.up(db);
      db.pragma(`user_version = ${m.id}`);
    }).immediate();
  }
  if (backup) pruneBackups(path.dirname(backup), BACKUPS_KEPT);
}

/** A brand-new file: no tables yet, so there is nothing to back up. */
function isFresh(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .get() as { c: number };
  return row.c === 0;
}

/** How many pre-migration backups to keep. Older ones are deleted. */
export const BACKUPS_KEPT = 5;

// sproutwall-v<from>-to-v<to>-<YYYYMMDD>T<HHMMSS><ms>Z-<nn>.db, in UTC. The
// version numbers have no fixed width, so age comes from the captured
// "<stamp>-<nn>" part, which does. Only files that match this pattern are ever
// deleted.
const BACKUP_NAME = /^sproutwall-v\d+-to-v\d+-(\d{8}T\d{9}Z-\d{2})\.db$/;

function fileSize(f: string): number {
  try {
    return fs.statSync(f).size;
  } catch {
    return 0;
  }
}

/**
 * Copy the database to backups/ and check the copy. Uses VACUUM INTO, which
 * writes a complete, consistent snapshot (WAL included) synchronously.
 * Throws DbBlockedError if there isn't room or the copy doesn't verify.
 */
export function createBackup(db: Database.Database, file: string, from: number, to: number): string {
  const dir = path.join(path.dirname(file), "backups");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    throw new DbBlockedError("backup_failed", `Could not create ${dir} for the pre-upgrade backup.`);
  }
  const needed = 2 * (fileSize(file) + fileSize(`${file}-wal`));
  try {
    const st = fs.statfsSync(dir);
    const free = st.bavail * st.bsize;
    if (free < needed) {
      // Byte counts go to the log only; /api/health needs no PIN.
      console.error(`[db] pre-upgrade backup needs ${needed} bytes free, ${free} available.`);
      throw new DbBlockedError("low_disk", "Not enough free space for the pre-upgrade backup.");
    }
  } catch (e) {
    if (isDbBlocked(e)) throw e;
    // statfs unavailable: fall through and let the copy itself fail if it must.
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(".", "").slice(0, 18) + "Z";
  const p2 = (n: number) => String(n).padStart(2, "0");
  // Claim a free name by creating it empty and exclusively ("wx"), so two
  // processes can't pick the same name. VACUUM INTO accepts an empty file.
  // From here on the file is ours, so removing it on failure is safe.
  let dest = "";
  for (let n = 0; n < 100 && !dest; n++) {
    const candidate = path.join(dir, `sproutwall-v${from}-to-v${to}-${stamp}-${p2(n)}.db`);
    try {
      fs.closeSync(fs.openSync(candidate, "wx"));
      dest = candidate;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        console.error(`[db] pre-upgrade backup failed: ${(e as Error).message}`);
        throw new DbBlockedError("backup_failed", "The pre-upgrade backup could not be made or verified.");
      }
    }
  }
  if (!dest) {
    console.error("[db] pre-upgrade backup failed: no free backup file name for this timestamp.");
    throw new DbBlockedError("backup_failed", "The pre-upgrade backup could not be made or verified.");
  }
  try {
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    const check = new Database(dest, { readonly: true, fileMustExist: true });
    try {
      const result = check.pragma("quick_check", { simple: true });
      if (result !== "ok") throw new Error(`quick_check: ${String(result)}`);
    } finally {
      check.close();
    }
  } catch (e) {
    fs.rmSync(dest, { force: true });
    console.error(`[db] pre-upgrade backup failed: ${(e as Error).message}`);
    throw new DbBlockedError("backup_failed", "The pre-upgrade backup could not be made or verified.");
  }
  return dest;
}

/** Delete all but the newest `keep` backups. Only our own file names are touched. */
export function pruneBackups(dir: string, keep: number): void {
  const age = (f: string) => BACKUP_NAME.exec(f)![1];
  const names = fs
    .readdirSync(dir)
    .filter((f) => BACKUP_NAME.test(f))
    .sort((a, b) => (age(a) < age(b) ? -1 : age(a) > age(b) ? 1 : a < b ? -1 : a > b ? 1 : 0));
  for (const old of names.slice(0, Math.max(0, names.length - keep))) {
    fs.rmSync(path.join(dir, old), { force: true });
  }
}

/**
 * Run the server's clock in the household's timezone. Docker containers
 * default to UTC, which made "today", weekdays and SQLite's 'localtime'
 * flip to tomorrow in the evening for US households. Node applies a TZ change
 * at runtime (it calls tzset), so this also covers SQLite.
 */
export function applyHouseholdTimezone(db: Database.Database = getDb()): void {
  const row = db.prepare("SELECT value FROM settings WHERE key='timezone'").get() as { value: string } | undefined;
  const tz = row?.value;
  if (!tz || process.env.TZ === tz) return;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    return;
  }
  process.env.TZ = tz;
}

/**
 * While the data is blocked, every request would otherwise retry createDb, and
 * for low_disk or backup_failed that means another statfs and copy attempt per
 * request. Remember the block for a short while instead. It still clears by
 * itself (for example once disk space is freed), within BLOCKED_RETRY_MS.
 */
export const BLOCKED_RETRY_MS = 60_000;
let blocked: { error: DbBlockedError; at: number } | null = null;

export function getDb(): Database.Database {
  if (!globalThis.__sproutwallDb) {
    if (blocked && Date.now() - blocked.at < BLOCKED_RETRY_MS) throw blocked.error;
    try {
      globalThis.__sproutwallDb = createDb();
      blocked = null;
    } catch (e) {
      if (isDbBlocked(e)) blocked = { error: e, at: Date.now() };
      throw e;
    }
  }
  return globalThis.__sproutwallDb;
}

/**
 * The fictional sample family. A fresh database starts with them, and so does
 * an install from before the members table existed, so the sample seed below
 * (and an existing household's data) stays valid. First-run setup can replace
 * them (lib/household.ts replaceHousehold).
 */
const SAMPLE_MEMBERS: [id: string, name: string, role: "kid" | "parent", age: number | null, preReader: boolean, color: string][] = [
  ["riley", "Riley", "kid", 11, false, "#6E9BBD"],
  ["quinn", "Quinn", "kid", 8, false, "#7FA576"],
  ["sam", "Sam", "kid", 5, true, "#D9A254"],
  ["avery", "Avery", "parent", null, false, "#5E7B86"],
  ["jordan", "Jordan", "parent", null, false, "#8A6D9E"],
];

function seedMembers(db: Database.Database) {
  const n = (db.prepare("SELECT COUNT(*) c FROM members").get() as { c: number }).c;
  if (n > 0) return;
  const ins = db.prepare(
    "INSERT INTO members (id, name, role, age, pre_reader, color, sort, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)"
  );
  db.transaction(() => {
    SAMPLE_MEMBERS.forEach(([id, name, role, age, preReader, color], i) =>
      ins.run(id, name, role, age, preReader ? 1 : 0, color, i + 1)
    );
  })();
}

function activeKidIds(db: Database.Database): string[] {
  return (
    db.prepare("SELECT id FROM members WHERE role='kid' AND active=1 ORDER BY sort, rowid").all() as { id: string }[]
  ).map((r) => r.id);
}

/**
 * Default data that every start makes sure exists: the sample members on an
 * empty household, the starter activities, the Task Box presets and the
 * rewards menu. Each part checks first, so this is safe to run every time.
 */
function seedDefaults(db: Database.Database) {
  seedMembers(db);
  // Seed per-kid activities once (from the original hardcoded five). The flag
  // keeps a household that set up its own family (and so has no activities
  // yet) from getting the sample sports on the next start.
  const activitiesSeeded = db.prepare("SELECT value FROM settings WHERE key='activities_seeded'").get();
  const an = (db.prepare("SELECT COUNT(*) c FROM activities").get() as { c: number }).c;
  if (!activitiesSeeded && an === 0) {
    const a = db.prepare(
      "INSERT INTO activities (kid, slug, label, emoji, metric, unit, sort) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    for (const kid of activeKidIds(db)) {
      a.run(kid, "soccer", "Soccer", "⚽", "duration", "min", 1);
      a.run(kid, "lacrosse", "Lacrosse", "🥍", "duration", "min", 2);
      a.run(kid, "juggling", "Juggling", "🤹", "count", "touches", 3);
      a.run(kid, "shooting", "Shooting", "🥅", "count", "makes", 4);
      a.run(kid, "workout", "Workout", "💪", "duration", "min", 5);
    }
  }
  if (!activitiesSeeded) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('activities_seeded','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
  }

  // Seed the Task Box preset library once.
  const tbCount = (db.prepare("SELECT COUNT(*) c FROM task_box").get() as { c: number }).c;
  if (tbCount === 0) {
    const tb = db.prepare("INSERT INTO task_box (label, emoji, bucket, tracked, type) VALUES (?, ?, ?, ?, ?)");
    const presets: [string, string, string, number, string][] = [
      ["Brush Teeth", "🪥", "morning", 0, "routine"],
      ["Get Dressed", "👕", "morning", 0, "routine"],
      ["Make Bed", "🛏️", "morning", 0, "routine"],
      ["Homework", "📓", "afternoon", 1, "routine"],
      ["Reading", "📖", "evening", 1, "routine"],
      ["Piano", "🎹", "afternoon", 1, "routine"],
      ["Soccer", "⚽", "afternoon", 1, "routine"],
      ["Chinese", "🀄", "afternoon", 1, "routine"],
      ["Journaling", "✏️", "evening", 0, "routine"],
      ["Shower", "🚿", "evening", 0, "routine"],
      ["Vitamins", "💊", "evening", 0, "routine"],
      ["Take Out Trash", "🗑️", "afternoon", 0, "job"],
      ["Clean Your Room", "🧹", "afternoon", 0, "job"],
      ["Feed the Pet", "🐕", "afternoon", 0, "job"],
      ["Set the Table", "🍽️", "afternoon", 0, "job"],
      ["Water the Plants", "🪴", "afternoon", 0, "job"],
    ];
    for (const p of presets) tb.run(...p);
  }

  // Seed the rewards menu once, even on already-seeded DBs.
  const n = (db.prepare("SELECT COUNT(*) c FROM rewards").get() as { c: number }).c;
  if (n === 0) {
    const r = db.prepare("INSERT INTO rewards (label, emoji, cost) VALUES (?, ?, ?)");
    r.run("Pick Family Movie Night", "🎬", 50);
    r.run("Choose Dessert", "🍦", 30);
    r.run("30 min Extra Screen Time", "🎮", 40);
    r.run("Stay Up 30 min Late", "🌙", 60);
    r.run("One-on-One Outing", "🚗", 120);
    r.run("$10 Toy Budget", "🧸", 150);
  }
}

function seed(db: Database.Database) {
  const seeded = db.prepare("SELECT value FROM settings WHERE key='seeded'").get() as
    | { value: string }
    | undefined;
  if (seeded) return;

  const tx = db.transaction(() => {
    // ---- settings ----
    const setSetting = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
    setSetting.run("setup_complete", "0");
    setSetting.run("currency_name", "Family Bucks");
    setSetting.run("family_name", "The Calder family");
    setSetting.run("family_greeting", "Calders");
    setSetting.run("weather_lat", "39.10");
    setSetting.run("weather_lon", "-94.58");
    setSetting.run("timezone", "America/Chicago");
    setSetting.run("sleep_start", "21:30");
    setSetting.run("sleep_end", "06:00");
    setSetting.run("screensaver_idle_min", "10");
    setSetting.run("family_goal_label", "Family Adventure Day");
    setSetting.run("family_goal_emoji", "🎢");
    setSetting.run("family_goal_target", "1500");
    setSetting.run("kid_jar_target", "200");

    // ---- task values (global actions; checklist items carry their own) ----
    const tv = db.prepare("INSERT INTO task_values (key, value, label) VALUES (?, ?, ?)");
    tv.run("levelup_log", 5, "Level Up session logged");
    tv.run("book_finish", 15, "Finished a book");
    tv.run("streak_bonus", 5, "Full-checklist day bonus");

    // ---- parent status ----
    const ps = db.prepare("INSERT INTO parent_status (member, status) VALUES (?, ?)");
    ps.run("avery", "Home");
    ps.run("jordan", "Home");

    // ---- checklist templates (per spec seed) ----
    // (kid, label, emoji, points, detail_kind, sort, bucket, tracked, unit, metric_label, contribution)
    const ct = db.prepare(
      "INSERT INTO checklist_templates (kid, label, emoji, points, detail_kind, sort, bucket, tracked, unit, metric_label, contribution) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    // Sam (pre-reader): morning basics + evening tidy, pure emoji taps
    ct.run("sam", "Brush Teeth", "🪥", 2, null, 1, "morning", 0, null, null, 0);
    ct.run("sam", "Get Dressed", "👕", 2, null, 2, "morning", 0, null, null, 0);
    ct.run("sam", "Pick Up Toys", "🧸", 3, null, 3, "evening", 0, null, null, 1);
    ct.run("sam", "Brush Teeth", "🪥", 2, null, 4, "evening", 0, null, null, 0);
    // Quinn: morning routine, afternoon practice, evening read + teeth
    ct.run("quinn", "Brush Teeth", "🪥", 2, null, 1, "morning", 0, null, null, 0);
    ct.run("quinn", "Make Bed", "🛏️", 2, null, 2, "morning", 0, null, null, 1);
    ct.run("quinn", "Practice", "⚽", 4, "levelup", 3, "afternoon", 1, "min", "Practice", 0);
    ct.run("quinn", "Read 20 Minutes", "📖", 4, "reading", 4, "evening", 1, "min", "Reading", 0);
    ct.run("quinn", "Brush Teeth", "🪥", 2, null, 5, "evening", 0, null, null, 0);
    // Riley: morning routine, afternoon practice, evening journal + read + teeth
    ct.run("riley", "Brush Teeth", "🪥", 2, null, 1, "morning", 0, null, null, 0);
    ct.run("riley", "Make Bed", "🛏️", 2, null, 2, "morning", 0, null, null, 1);
    ct.run("riley", "Practice", "⚽", 4, "levelup", 3, "afternoon", 1, "min", "Practice", 0);
    ct.run("riley", "Journal", "✏️", 3, null, 4, "evening", 0, null, null, 0);
    ct.run("riley", "Read 30 Minutes", "📖", 4, "reading", 5, "evening", 1, "min", "Reading", 0);
    ct.run("riley", "Brush Teeth", "🪥", 2, null, 6, "evening", 0, null, null, 0);

    // ---- family rules (5 placeholders) ----
    const fr = db.prepare("INSERT INTO family_rules (text, sort) VALUES (?, ?)");
    fr.run("We tell the truth.", 1);
    fr.run("We try hard things.", 2);
    fr.run("We are kind to each other.", 3);
    fr.run("We clean up our own messes.", 4);
    fr.run("We say please and thank you.", 5);

    // ---- meal defaults (rotating weekday dinners) ----
    const md = db.prepare("INSERT INTO meal_defaults (weekday, meal, emoji) VALUES (?, ?, ?)");
    md.run(0, "Roast Chicken", "🍗");
    md.run(1, "Pasta Night", "🍝");
    md.run(2, "Tacos", "🌮");
    md.run(3, "Stir Fry", "🥘");
    md.run(4, "Burgers", "🍔");
    md.run(5, "Pizza Night", "🍕");
    md.run(6, "Family Choice", "🍽️");

    // ---- grocery starter ----
    const g = db.prepare("INSERT INTO grocery (label) VALUES (?)");
    g.run("Milk");
    g.run("Tortillas");
    g.run("Fruit for lunches");

    // ---- placeholder calendar events (relative day offsets) ----
    const ev = db.prepare(
      "INSERT INTO events (member, title, day_offset, start, end, location) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const rows: [string, string, number, string | null, string | null, string | null][] = [
      ["riley", "School", 0, "08:30", "15:00", null],
      ["riley", "Soccer Practice", 0, "16:30", "17:30", "the park"],
      ["riley", "Swim Class", 1, "16:00", "17:00", null],
      ["riley", "Chess Club", 2, "15:15", "16:15", null],
      ["riley", "Soccer Game vs Falcons", 3, "09:00", "10:30", "Field 4"],
      ["quinn", "School", 0, "08:30", "15:00", null],
      ["quinn", "Piano Lesson", 0, "16:00", "16:45", null],
      ["quinn", "Soccer Practice", 1, "16:30", "17:30", "the park"],
      ["quinn", "Art Class", 2, "16:00", "17:00", null],
      ["quinn", "Piano Recital", 4, "17:00", "18:00", null],
      ["sam", "Pre-K", 0, "09:00", "13:00", null],
      ["sam", "Playdate", 0, "15:30", "17:00", null],
      ["sam", "Story Time @ Library", 1, "10:30", "11:15", null],
      ["sam", "Soccer Tots", 4, "10:00", "10:45", null],
      ["avery", "Team Standup", 0, "10:00", "10:30", null],
      ["avery", "Investor Call", 1, "14:00", "15:00", null],
      ["avery", "Family Pizza Night", 3, "18:00", "19:30", null],
      ["jordan", "Yoga", 0, "18:00", "19:00", null],
      ["jordan", "PTA Meeting", 2, "19:00", "20:00", null],
      ["jordan", "Book Club", 5, "19:30", "21:00", null],
    ];
    for (const r of rows) ev.run(...r);

    // ---- starter history so jars/streaks/shelves aren't empty ----
    const led = db.prepare(
      "INSERT INTO ledger (kid, amount, source, label, created_at) VALUES (?, ?, ?, ?, datetime('now','localtime', ?))"
    );
    led.run("riley", 10, "myday", "Checklist", "-2 days");
    led.run("riley", 5, "levelup", "Juggling session", "-1 days");
    led.run("quinn", 8, "myday", "Checklist", "-2 days");
    led.run("quinn", 5, "levelup", "Soccer session", "-1 days");
    led.run("sam", 7, "myday", "Checklist", "-1 days");

    const lu = db.prepare(
      "INSERT INTO levelup_logs (kid, activity, duration_min, count, created_at) VALUES (?, ?, ?, ?, datetime('now','localtime', ?))"
    );
    lu.run("riley", "juggling", null, 8, "-6 days");
    lu.run("riley", "juggling", null, 11, "-4 days");
    lu.run("riley", "juggling", null, 14, "-1 days");
    lu.run("riley", "soccer", 45, null, "-2 days");
    lu.run("riley", "shooting", null, 12, "-3 days");
    lu.run("quinn", "juggling", null, 4, "-5 days");
    lu.run("quinn", "juggling", null, 7, "-1 days");
    lu.run("quinn", "soccer", 30, null, "-2 days");
    lu.run("sam", "soccer", 20, null, "-1 days");

    const bk = db.prepare(
      "INSERT INTO books (kid, title, author, status, started_at, finished_at) VALUES (?, ?, ?, ?, datetime('now','localtime', ?), ?)"
    );
    bk.run("riley", "The Wonderful Wizard of Oz", "L. Frank Baum", "reading", "-5 days", null);
    bk.run("riley", "Alice's Adventures in Wonderland", "Lewis Carroll", "finished", "-30 days", "2026-07-05");
    bk.run("riley", "The Tale of Peter Rabbit", "Beatrix Potter", "finished", "-60 days", "2026-06-10");
    bk.run("riley", "Black Beauty", "Anna Sewell", "finished", "-90 days", "2026-05-02");
    bk.run("quinn", "The Secret Garden", "Frances Hodgson Burnett", "reading", "-3 days", null);
    bk.run("quinn", "The Wind in the Willows", "Kenneth Grahame", "finished", "-40 days", "2026-06-28");
    bk.run("quinn", "The Jungle Book", "Rudyard Kipling", "finished", "-70 days", "2026-05-20");
    bk.run("sam", "Aesop's Fables", "Aesop", "reading", "-2 days", null);
    bk.run("sam", "The Velveteen Rabbit", "Margery Williams", "finished", "-25 days", "2026-06-30");

    setSetting.run("seeded", "1");
    setSetting.run("buckets_migrated", "1"); // fresh seed already bucketed
  });
  tx();
}
