import { baseline } from "./0001-baseline";
import { moduleState } from "./0002-module-state";
import type { Migration } from "./types";

export type { Migration } from "./types";

// Every schema step, in order. Add new ones at the end with the next id; never
// change or remove one that has shipped.
export const MIGRATIONS: Migration[] = [baseline, moduleState];

/** The schema version this build writes (PRAGMA user_version after migrating). */
export const LATEST_SCHEMA = MIGRATIONS[MIGRATIONS.length - 1].id;
