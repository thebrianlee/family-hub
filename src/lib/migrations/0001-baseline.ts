import type Database from "better-sqlite3";

import type { Migration } from "./types";

// Migration 1 is the schema as it stood before numbered migrations existed
// (commit da1ecc2): every CREATE TABLE plus every column and one-time data move
// that the old startup code added with "if missing" checks. All of it is
// idempotent, so it is safe on a brand-new database and on any database made
// by an older build (those all have user_version 0).
//
// Never edit this file. Put every later schema change in a new numbered file.

function createTables(db: Database.Database) {
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
}

/** Columns, tables and one-time data moves added after the first release. Idempotent. */
function upgradeColumns(db: Database.Database) {
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

}


export const baseline: Migration = {
  id: 1,
  name: "baseline",
  up(db) {
    createTables(db);
    upgradeColumns(db);
  },
};
