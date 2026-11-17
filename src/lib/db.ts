import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { dataDir } from "./paths";

// Singleton SQLite handle. Survives Next.js dev-server hot reloads via globalThis.
const DB_PATH = process.env.FAMILY_HUB_DB
  ? path.resolve(process.env.FAMILY_HUB_DB)
  : path.join(dataDir(), "family-hub.db");

declare global {
  var __familyHubDb: Database.Database | undefined;
}

function createDb(): Database.Database {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  migrate(db);
  ensureColumns(db);
  seed(db);
  applyHouseholdTimezone(db);
  return db;
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

export function getDb(): Database.Database {
  if (!globalThis.__familyHubDb) {
    globalThis.__familyHubDb = createDb();
  }
  return globalThis.__familyHubDb;
}

function migrate(db: Database.Database) {
  db.exec(`
    -- The household. id is a CSS-safe slug derived from the name (see
    -- lib/household.ts); every other table refers to people by this id.
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('kid','parent')),
      age INTEGER NULL,
      pre_reader INTEGER NOT NULL DEFAULT 0,
      color TEXT NOT NULL,                     -- #RRGGBB from the member palette
      sort INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );

    -- Placeholder calendar events. The Google Calendar integration replaces
    -- the PROVIDER (lib/calendar.ts), not the consumers; this table only backs
    -- the placeholder provider. day_offset keeps seed data relative to today.
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member TEXT NOT NULL,
      title TEXT NOT NULL,
      day_offset INTEGER NOT NULL DEFAULT 0,   -- 0=today, 1=tomorrow…
      start TEXT,                              -- "HH:MM", NULL = all-day
      end TEXT,
      location TEXT
    );

    -- Events pulled from each member's iCal link by src/lib/ics.ts. Once any
    -- link is set, the calendar shows these instead of the sample events.
    CREATE TABLE IF NOT EXISTS synced_events (
      id TEXT PRIMARY KEY,                     -- source-prefixed event id
      member TEXT NOT NULL,
      title TEXT NOT NULL,
      date TEXT NOT NULL,                      -- YYYY-MM-DD local (America/New_York)
      start TEXT,                              -- "HH:MM", NULL = all-day
      end TEXT,
      location TEXT,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      source TEXT                              -- 'own' | 'shared'; NULL = written before this column
    );

    -- Events created on the wall itself (the ＋ Add flow). Kept separate from
    -- synced_events so the ICS refresh (per-member replace) never wipes them;
    -- the calendar provider unions both. One row per member on the event.
    CREATE TABLE IF NOT EXISTS wall_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,                  -- shared id across a multi-member event
      member TEXT NOT NULL,
      title TEXT NOT NULL,
      date TEXT NOT NULL,                       -- YYYY-MM-DD local
      start TEXT,                               -- "HH:MM", NULL = all-day
      end TEXT,
      location TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS checklist_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kid TEXT NOT NULL,
      label TEXT NOT NULL,
      emoji TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 2,
      detail_kind TEXT,                        -- NULL | 'reading' | 'levelup'
      sort INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS checklist_completions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER NOT NULL REFERENCES checklist_templates(id),
      kid TEXT NOT NULL,
      date TEXT NOT NULL,                      -- YYYY-MM-DD local
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(template_id, date)
    );

    -- Task Box: reusable routine/job presets you can tap-add to any kid.
    CREATE TABLE IF NOT EXISTS task_box (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '✅',
      bucket TEXT NOT NULL DEFAULT 'morning',
      tracked INTEGER NOT NULL DEFAULT 0,
      type TEXT NOT NULL DEFAULT 'routine'
    );

    -- One-tap daily mood per kid. Feeds the quiet week-over-week strip.
    CREATE TABLE IF NOT EXISTS mood_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kid TEXT NOT NULL,
      date TEXT NOT NULL,                      -- YYYY-MM-DD local
      mood TEXT NOT NULL,                      -- great|good|ok|sad|mad
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(kid, date)
    );

    CREATE TABLE IF NOT EXISTS levelup_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kid TEXT NOT NULL,
      activity TEXT NOT NULL,                  -- soccer|lacrosse|juggling|shooting|workout
      duration_min REAL,
      count REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kid TEXT NOT NULL,
      title TEXT NOT NULL,
      author TEXT,
      status TEXT NOT NULL DEFAULT 'reading',  -- reading | finished
      started_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS book_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL REFERENCES books(id),
      kid TEXT NOT NULL,
      prompt TEXT,
      answer TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    -- Family Bucks ledger. Positive = earned, negative = spent (future).
    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kid TEXT NOT NULL,
      amount INTEGER NOT NULL,
      source TEXT NOT NULL,                    -- myday | levelup | book | streak_bonus | redeem
      label TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    -- Global task values (checklist items carry their own value per-row).
    CREATE TABLE IF NOT EXISTS task_values (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL,
      label TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meal_defaults (
      weekday INTEGER PRIMARY KEY,             -- 0=Sunday … 6=Saturday
      meal TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '🍽️'
    );

    CREATE TABLE IF NOT EXISTS meal_overrides (
      date TEXT PRIMARY KEY,                   -- YYYY-MM-DD
      meal TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '🍽️'
    );

    -- Full meal grid: one row per (date, slot). slot = breakfast|lunch|dinner|snack.
    CREATE TABLE IF NOT EXISTS meal_slots (
      date TEXT NOT NULL,                      -- YYYY-MM-DD
      slot TEXT NOT NULL,
      name TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '🍽️',
      ingredients TEXT,                        -- newline-separated, for Add-to-List
      PRIMARY KEY (date, slot)
    );

    CREATE TABLE IF NOT EXISTS grocery (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      checked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    -- Named lists (Groceries, Packing, To-Do…), each with collapsible sections.
    CREATE TABLE IF NOT EXISTS lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#6E9BBD',
      sort INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS list_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id INTEGER NOT NULL REFERENCES lists(id),
      section TEXT NOT NULL DEFAULT 'General',
      label TEXT NOT NULL,
      checked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS family_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      sort INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS parent_status (
      member TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'Home'
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Daily Spark cache: a nightly Anthropic API job can INSERT fresh rows;
    -- lib/spark.ts prefers cache rows over the hardcoded lists.
    CREATE TABLE IF NOT EXISTS spark_cache (
      date TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      PRIMARY KEY (date, kind)
    );

    -- Rewards menu ("legend"): what things cost. kid NULL = family-wide item.
    CREATE TABLE IF NOT EXISTS rewards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '🎁',
      cost INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );

    -- Level Up activities: seeded five per kid, kids can add their own.
    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kid TEXT NOT NULL,
      slug TEXT NOT NULL,
      label TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '🏅',
      metric TEXT NOT NULL DEFAULT 'count',   -- count | duration
      unit TEXT NOT NULL DEFAULT 'reps',
      sort INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      UNIQUE(kid, slug)
    );

    -- Kid-proposed rewards awaiting a parent-set price.
    CREATE TABLE IF NOT EXISTS reward_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kid TEXT NOT NULL,
      label TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '🎁',
      status TEXT NOT NULL DEFAULT 'pending', -- pending | priced | declined
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    -- A kid's chosen goal: shows a progress bar on their Balance card.
    CREATE TABLE IF NOT EXISTS selected_goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kid TEXT NOT NULL,
      label TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '🎯',
      cost INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_completions ON checklist_completions(kid, date);
    CREATE INDEX IF NOT EXISTS idx_levelup ON levelup_logs(kid, activity, created_at);
    CREATE INDEX IF NOT EXISTS idx_ledger ON ledger(kid, created_at);
    CREATE INDEX IF NOT EXISTS idx_books ON books(kid, status);
  `);
  seedMembers(db);
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

/** Idempotent post-create migrations for DBs seeded before these columns existed. */
function ensureColumns(db: Database.Database) {
  const cols = (db.prepare("PRAGMA table_info(books)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("isbn")) db.exec("ALTER TABLE books ADD COLUMN isbn TEXT");
  if (!cols.includes("cover_path")) db.exec("ALTER TABLE books ADD COLUMN cover_path TEXT");
  if (!cols.includes("author_full")) {
    /* placeholder for future migrations */
  }

  // Routine buckets + inline tracking (added for the July restructure).
  // bucket: morning|afternoon|evening. tracked items carry ONE inline number
  // (amount on the completion) that accumulates into Progress under metric_label.
  const tcols = (db.prepare("PRAGMA table_info(checklist_templates)").all() as { name: string }[]).map((c) => c.name);
  if (!tcols.includes("bucket")) db.exec("ALTER TABLE checklist_templates ADD COLUMN bucket TEXT NOT NULL DEFAULT 'morning'");
  if (!tcols.includes("tracked")) db.exec("ALTER TABLE checklist_templates ADD COLUMN tracked INTEGER NOT NULL DEFAULT 0");
  if (!tcols.includes("unit")) db.exec("ALTER TABLE checklist_templates ADD COLUMN unit TEXT");
  if (!tcols.includes("metric_label")) db.exec("ALTER TABLE checklist_templates ADD COLUMN metric_label TEXT");
  if (!tcols.includes("contribution")) db.exec("ALTER TABLE checklist_templates ADD COLUMN contribution INTEGER NOT NULL DEFAULT 0");
  const ccols = (db.prepare("PRAGMA table_info(checklist_completions)").all() as { name: string }[]).map((c) => c.name);
  if (!ccols.includes("amount")) db.exec("ALTER TABLE checklist_completions ADD COLUMN amount REAL");
  // Countdown flag on wall events — shows a "in N sleeps" badge (kids love it).
  const wcols = (db.prepare("PRAGMA table_info(wall_events)").all() as { name: string }[]).map((c) => c.name);
  if (!wcols.includes("countdown")) db.exec("ALTER TABLE wall_events ADD COLUMN countdown INTEGER NOT NULL DEFAULT 0");
  // Which feed a synced event came from: 'own' (the member's link) or 'shared'
  // (the kids' shared link). Rows from before this column keep NULL; the next
  // refresh replaces them (lib/ics.ts).
  const scols = (db.prepare("PRAGMA table_info(synced_events)").all() as { name: string }[]).map((c) => c.name);
  if (!scols.includes("source")) db.exec("ALTER TABLE synced_events ADD COLUMN source TEXT");
  // Emoji per family rule (shown instead of a number in the Family Rules view).
  const frcols = (db.prepare("PRAGMA table_info(family_rules)").all() as { name: string }[]).map((c) => c.name);
  if (!frcols.includes("emoji")) db.exec("ALTER TABLE family_rules ADD COLUMN emoji TEXT NOT NULL DEFAULT '📜'");

  // Ask the Hub — every kid question + answer, parent-reviewable.
  db.exec(`
    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kid TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      source TEXT NOT NULL,                    -- claude | ollama
      model TEXT NOT NULL,
      latency_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_questions_created ON questions(created_at DESC);

    -- Ask the Hub cost ceiling: one row per question sent to the model,
    -- written before the call, so a question whose answer never gets logged
    -- (timeout, bridge error) still counts. created_at is UTC.
    CREATE TABLE IF NOT EXISTS ask_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ask_usage_created ON ask_usage(created_at);

    -- Operation keys of ledger writes the screen may send twice (a double tap
    -- or a retried request on redeem). A key seen before is not charged again.
    -- created_at is UTC.
    CREATE TABLE IF NOT EXISTS ledger_ops (
      op_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // days: which weekdays this routine shows on. String of digits 0=Sun..6=Sat;
  // default all days. Lets a routine be Mon/Wed/Fri instead of every day.
  if (!tcols.includes("days")) db.exec("ALTER TABLE checklist_templates ADD COLUMN days TEXT NOT NULL DEFAULT '0123456'");
  // type: 'routine' (recurring, time-bucketed) | 'job' (a helping task, dated or
  // recurring, shown in its own Jobs section — the warmer name for "chore").
  if (!tcols.includes("type")) db.exec("ALTER TABLE checklist_templates ADD COLUMN type TEXT NOT NULL DEFAULT 'routine'");
  // due_date: for one-off jobs (YYYY-MM-DD). NULL = recurring (uses `days`).
  if (!tcols.includes("due_date")) db.exec("ALTER TABLE checklist_templates ADD COLUMN due_date TEXT");

  // One-time: bucket the originally-seeded items, split brush-teeth into a
  // morning + evening pair, and flag the tracked ones. Guarded so it runs once
  // and never fights hand-edits the parents make later.
  const migrated = db.prepare("SELECT value FROM settings WHERE key='buckets_migrated'").get() as
    | { value: string }
    | undefined;
  if (!migrated && (db.prepare("SELECT COUNT(*) c FROM checklist_templates").get() as { c: number }).c > 0) {
    const tx = db.transaction(() => {
      const put = db.prepare(
        "UPDATE checklist_templates SET bucket=?, tracked=?, unit=?, metric_label=?, contribution=? WHERE kid=? AND label=? AND active=1"
      );
      // label -> [bucket, tracked, unit, metric_label, contribution]
      const plan: Record<string, [string, number, string | null, string | null, number]> = {
        "Brush Teeth": ["morning", 0, null, null, 0],
        "Get Dressed": ["morning", 0, null, null, 0],
        "Make Bed": ["morning", 0, null, null, 1],
        "Journal": ["evening", 0, null, null, 0],
        "Pick Up Toys": ["evening", 0, null, null, 1],
        "Read 20 Minutes": ["evening", 1, "min", "Reading", 0],
        "Read 30 Minutes": ["evening", 1, "min", "Reading", 0],
        "Practice": ["afternoon", 1, "min", "Practice", 0],
      };
      // Every kid that has routine items (on these old installs: the sample kids).
      const routineKids = (
        db.prepare("SELECT DISTINCT kid FROM checklist_templates").all() as { kid: string }[]
      ).map((r) => r.kid);
      for (const kid of routineKids) {
        for (const [label, [bucket, tracked, unit, metric, contrib]] of Object.entries(plan)) {
          put.run(bucket, tracked, unit, metric, contrib, kid, label);
        }
      }
      // Evening tooth-brushing: a second item so it shows in both buckets.
      const maxSort = db.prepare(
        "SELECT kid, COALESCE(MAX(sort),0) m FROM checklist_templates GROUP BY kid"
      ).all() as { kid: string; m: number }[];
      const sortByKid = Object.fromEntries(maxSort.map((r) => [r.kid, r.m]));
      const insBrush = db.prepare(
        "INSERT INTO checklist_templates (kid, label, emoji, points, detail_kind, sort, bucket) VALUES (?, 'Brush Teeth', '🪥', 2, NULL, ?, 'evening')"
      );
      for (const kid of routineKids) {
        const already = db
          .prepare("SELECT COUNT(*) c FROM checklist_templates WHERE kid=? AND label='Brush Teeth' AND bucket='evening' AND active=1")
          .get(kid) as { c: number };
        if (already.c === 0) insBrush.run(kid, (sortByKid[kid] ?? 0) + 1);
      }
      db.prepare("INSERT INTO settings (key, value) VALUES ('buckets_migrated','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
    });
    tx();
  }
  // rewards.kid: NULL = family-wide menu item; set = that kid's own item.
  const rcols = (db.prepare("PRAGMA table_info(rewards)").all() as { name: string }[]).map((c) => c.name);
  if (!rcols.includes("kid")) db.exec("ALTER TABLE rewards ADD COLUMN kid TEXT");

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

  // Named lists: create defaults + migrate existing grocery items once.
  const listsMig = db.prepare("SELECT value FROM settings WHERE key='lists_migrated'").get();
  if (!listsMig) {
    const tx = db.transaction(() => {
      const insL = db.prepare("INSERT INTO lists (name, color, sort) VALUES (?, ?, ?)");
      const groId = insL.run("Groceries", "#7FA576", 1).lastInsertRowid;
      insL.run("Packing", "#6E9BBD", 2);
      insL.run("To-Do", "#D9A254", 3);
      const items = db.prepare("SELECT label, checked FROM grocery").all() as { label: string; checked: number }[];
      const insI = db.prepare("INSERT INTO list_items (list_id, section, label, checked) VALUES (?, 'General', ?, ?)");
      for (const it of items) insI.run(groId, it.label, it.checked);
      db.prepare("INSERT INTO settings (key, value) VALUES ('lists_migrated','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
    });
    tx();
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
