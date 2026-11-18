import type Database from "better-sqlite3";

import type { Migration } from "./types";

// Migration 2: which built-in modules are on (src/lib/modules.ts). Additive
// only: one new table, no change to any existing table or row.
//
// - A household that already finished setup gets every module on, Ask
//   included, so an upgrade never takes away a feature the family uses.
// - A database that is not set up yet gets no rows; first-run setup writes
//   them (api/setup), in its claim transaction.
// - Rows for ids this build doesn't know are left alone.
//
// Never edit this file once shipped. The id list is frozen here on purpose: a
// module added in a later version has no row on upgrade, so it starts at its
// own default (the read rule in src/lib/modules.ts), not "on".

const MODULES_AT_V2 = ["calendar", "routines", "rewards", "progress", "reading", "meals", "lists", "ask"];

function setupComplete(db: Database.Database): boolean {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get();
  if (!table) return false;
  const row = db.prepare("SELECT value FROM settings WHERE key='setup_complete'").get() as { value: string } | undefined;
  return row?.value === "1";
}

export const moduleState: Migration = {
  id: 2,
  name: "module-state",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS module_state (
        id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    if (!setupComplete(db)) return;
    const insert = db.prepare("INSERT OR IGNORE INTO module_state (id, enabled) VALUES (?, 1)");
    for (const id of MODULES_AT_V2) insert.run(id);
  },
};
