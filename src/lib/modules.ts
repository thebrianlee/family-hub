import { getDb } from "./db";
import {
  MODULES,
  TOGGLEABLE_MODULES,
  applyModuleChanges,
  defaultModuleState,
  getModule,
  type ModuleManifestV0,
  type ModuleState,
} from "@/modules/registry";

// Which built-in modules are on (src/modules/registry.ts lists them). One row
// per toggleable module in module_state (migration 0002). Turning a module off
// hides it: its pages, API routes, Today slots and background work stop, and
// every row of its data stays. Nothing here deletes data.
//
// Read rule: a module with no row falls back to its defaultEnabled (a module
// added by a later version). Rows for ids this build doesn't know (written by
// a newer version) are ignored, never deleted. A module whose dependency is
// off counts as off.
//
// No cache: the proxy reads this on every request to a module's path, with one
// small query, so a toggle takes effect on the very next request.

export type ModuleChanges = ModuleState;

function storedRows(): ModuleState {
  const rows = getDb().prepare("SELECT id, enabled FROM module_state").all() as { id: string; enabled: number }[];
  return Object.fromEntries(rows.map((r) => [r.id, r.enabled === 1]));
}

/** Every toggleable module's effective state, dependsOn applied. */
function effectiveState(stored: ModuleState = storedRows()): ModuleState {
  return applyModuleChanges(stored, {});
}

export function isEnabled(id: string): boolean {
  const m = getModule(id);
  if (!m) return false;
  if (m.core) return true;
  return effectiveState()[id] === true;
}

/** Ids of the modules that are on, core included, in registry order. */
export function enabledModules(): string[] {
  const state = effectiveState();
  return MODULES.filter((m: ModuleManifestV0) => m.core || state[m.id]).map((m) => m.id);
}

/** The state of every toggleable module, for Settings. */
export function moduleStates(): ModuleState {
  return effectiveState();
}

export type ModuleTab = { id: string; href: string; label: string };

/** The tab bar, in order: Today plus each enabled module that has a tab. */
export function enabledTabs(on: readonly string[] = enabledModules()): ModuleTab[] {
  return (MODULES as readonly ModuleManifestV0[])
    .filter((m) => m.tab && on.includes(m.id))
    .sort((a, b) => a.tab!.order - b.tab!.order)
    .map((m) => ({ id: m.id, href: m.tab!.href, label: m.tab!.label }));
}

/**
 * Switch modules on or off, with the dependsOn rules (registry
 * applyModuleChanges), in one transaction. Inside a caller's transaction (the
 * setup claim) this is a savepoint, so it commits or rolls back with it.
 * Writes a row for every toggleable module, so a fresh install stores its
 * choices and keeps them even if a later version changes a default. First-run
 * setup starts from the defaults; Settings starts from what is stored.
 */
export function setEnabled(changes: ModuleChanges, { actor }: { actor: "setup" | "parent" }): ModuleState {
  const db = getDb();
  return db.transaction(() => {
    const before = effectiveState();
    const next = applyModuleChanges(actor === "setup" ? defaultModuleState() : before, changes);
    const write = db.prepare(
      `INSERT INTO module_state (id, enabled) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, updated_at=datetime('now')
       WHERE module_state.enabled <> excluded.enabled`
    );
    for (const m of TOGGLEABLE_MODULES) write.run(m.id, next[m.id] ? 1 : 0);
    const on = TOGGLEABLE_MODULES.filter((m) => next[m.id] && !before[m.id]).map((m) => m.id);
    const off = TOGGLEABLE_MODULES.filter((m) => !next[m.id] && before[m.id]).map((m) => m.id);
    if (on.length || off.length) {
      console.log(`[modules] ${actor}: on [${on.join(", ")}] off [${off.join(", ")}]`);
    }
    return next;
  })();
}

export type ModuleInput = { ok: true; changes: ModuleChanges } | { ok: false; error: string };

/**
 * Check an { id: boolean } object from a request. Unknown ids and non-boolean
 * values are refused; core ids are ignored (core is always on).
 */
export function parseModuleChanges(input: unknown): ModuleInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "Send modules as { id: true or false }." };
  }
  const changes: ModuleChanges = {};
  for (const [id, on] of Object.entries(input)) {
    const m = getModule(id);
    if (!m) return { ok: false, error: `Unknown module: ${id.slice(0, 40)}` };
    if (m.core) continue;
    if (typeof on !== "boolean") return { ok: false, error: `Turn ${m.name} on or off with true or false.` };
    changes[id] = on;
  }
  return { ok: true, changes };
}
