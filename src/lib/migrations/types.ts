import type Database from "better-sqlite3";

/** One forward-only schema step. `id` becomes PRAGMA user_version once it has run. */
export type Migration = {
  id: number;
  name: string;
  up: (db: Database.Database) => void;
};
