// EXPERIMENTAL / INTERNAL. This format may change without notice until stage 2.
//
// The built-in modules: today's features, described so a parent can switch
// them on and off (Settings → Modules, and one screen in the first-run
// wizard). The fields are a strict subset of the skill.json manifest in
// docs/architecture/skills.md, plus a few v0-only fields marked below. This is
// not a contributor API: third-party skills are stage 2.
//
// Server-safe and client-safe: no React, no database, no Node imports. Module
// state (which ones are on) lives in src/lib/modules.ts.

export type ModuleSlot = "tab" | "today-card" | "kid-tab"; // subset of skills.md slots
export type DataScope = "members:read" | "routines:read" | "routines:write" | "ledger:award" | "calendar:read"; // skills.md scope names, informational in v0

export interface ModuleManifestV0 {
  id: string; // lowercase, unique; skills.md `id`
  name: string; // skills.md `name`
  description: string; // skills.md `description`, shown in the wizard and Settings
  version: string; // semver; skills.md `version`
  author: "core"; // built-ins only in v0
  permissions: {
    network: readonly string[]; // hosts this module may contact; must match code (test-enforced)
    data: readonly DataScope[]; // informational in v0 (built-ins use core code directly)
  };
  slots: readonly ModuleSlot[];
  sendsChildDataTo: readonly string[]; // required, even when empty (skills.md rule)
  // v0-only fields (not in skills.md; stage 2 decides if they become manifest fields)
  core?: true; // not toggleable
  defaultEnabled: boolean; // fresh-install default
  dependsOn?: readonly string[];
  pages: readonly string[]; // path prefixes owned, e.g. "/my-day"
  api: readonly string[]; // path prefixes owned, e.g. "/api/myday"
  tab?: { href: string; label: string; order: number };
}

export const MODULES = [
  {
    id: "core",
    name: "Today",
    description: "The clock, weather, greeting, where the parents are, and the family rules. Always on.",
    version: "0.1.0",
    author: "core",
    permissions: { network: ["api.open-meteo.com"], data: ["members:read"] },
    slots: ["tab", "today-card"],
    sendsChildDataTo: [],
    core: true,
    defaultEnabled: true,
    pages: ["/", "/today", "/settings", "/unlock"],
    api: [
      "/api/today",
      "/api/settings",
      "/api/setup",
      "/api/pin",
      "/api/health",
      "/api/status",
      "/api/rules",
      "/api/ambient",
      "/api/avatars",
      "/api/photos",
    ],
    tab: { href: "/today", label: "Today", order: 0 },
  },
  {
    id: "calendar",
    name: "Calendar",
    description: "The family's week, from each person's calendar link and events added on the wall.",
    version: "0.1.0",
    author: "core",
    // The iCal links parents paste in Settings; no fixed host.
    permissions: { network: ["user-configured"], data: ["members:read", "calendar:read"] },
    slots: ["tab", "today-card"],
    sendsChildDataTo: [],
    defaultEnabled: true,
    pages: ["/calendar"],
    api: ["/api/calendar", "/api/events", "/api/events/refresh"],
    tab: { href: "/calendar", label: "Calendar", order: 1 },
  },
  {
    id: "routines",
    name: "Routines",
    description: "Morning, afternoon and evening checklists and jobs for each kid, with progress rings on Today.",
    version: "0.1.0",
    author: "core",
    permissions: { network: [], data: ["members:read", "routines:read", "routines:write", "ledger:award"] },
    slots: ["tab", "today-card"],
    sendsChildDataTo: [],
    defaultEnabled: true,
    pages: ["/my-day"],
    api: ["/api/myday", "/api/myday/templates", "/api/taskbox"],
    tab: { href: "/my-day", label: "Routines", order: 2 },
  },
  {
    id: "rewards",
    name: "Points & jar",
    description: "Kids earn points for routines and jobs, and save them for rewards you choose.",
    version: "0.1.0",
    author: "core",
    permissions: { network: [], data: ["members:read", "ledger:award"] },
    slots: ["today-card", "kid-tab"],
    sendsChildDataTo: [],
    defaultEnabled: true,
    dependsOn: ["routines"],
    pages: ["/balance"],
    api: ["/api/balance"],
  },
  {
    id: "progress",
    name: "Progress & level-up",
    description: "Streaks, practice totals and mood history for each kid, inside Routines.",
    version: "0.1.0",
    author: "core",
    permissions: { network: [], data: ["members:read", "routines:read", "ledger:award"] },
    slots: ["kid-tab"],
    sendsChildDataTo: [],
    defaultEnabled: true,
    dependsOn: ["routines"],
    pages: ["/progress", "/level-up"],
    api: ["/api/progress", "/api/levelup"],
  },
  {
    id: "reading",
    name: "Reading log",
    description: "Each kid's books, reading minutes and bookshelf. Book search looks titles up online.",
    version: "0.1.0",
    author: "core",
    permissions: {
      network: ["openlibrary.org", "covers.openlibrary.org", "www.googleapis.com"],
      data: ["members:read", "ledger:award"],
    },
    slots: ["kid-tab"],
    sendsChildDataTo: [],
    defaultEnabled: true,
    pages: ["/reading"],
    api: ["/api/reading", "/api/books", "/api/covers"],
  },
  {
    id: "meals",
    name: "Meals",
    description: "The week's meal plan, with today's meals on the Today screen.",
    version: "0.1.0",
    author: "core",
    permissions: { network: [], data: [] },
    slots: ["tab", "today-card"],
    sendsChildDataTo: [],
    defaultEnabled: true,
    pages: ["/meals"],
    api: ["/api/meals"],
    tab: { href: "/meals", label: "Meals", order: 3 },
  },
  {
    id: "lists",
    name: "Lists",
    description: "Shared lists: groceries, packing, to-dos.",
    version: "0.1.0",
    author: "core",
    permissions: { network: [], data: [] },
    slots: ["tab"],
    sendsChildDataTo: [],
    defaultEnabled: true,
    pages: ["/lists"],
    api: ["/api/lists"],
    tab: { href: "/lists", label: "Lists", order: 4 },
  },
  {
    id: "ask",
    name: "Ask the Hub + Daily Spark",
    description: "Kids ask questions and get short answers from an AI, and a fresh daily quote fills the Spark tile.",
    version: "0.1.0",
    author: "core",
    permissions: { network: ["127.0.0.1 (bridge)"], data: ["members:read"] },
    slots: ["tab", "today-card"],
    sendsChildDataTo: ["Anthropic (via bridge, if configured)", "Ollama (local, if configured)"],
    defaultEnabled: false,
    pages: ["/ask"],
    api: ["/api/ask", "/api/spark"],
    tab: { href: "/ask", label: "Ask", order: 5 },
  },
] as const satisfies readonly ModuleManifestV0[];

export type ModuleId = (typeof MODULES)[number]["id"];

/** Modules a parent can switch on and off (everything but core). */
export const TOGGLEABLE_MODULES: readonly ModuleManifestV0[] = MODULES.filter((m: ModuleManifestV0) => !m.core);

export function getModule(id: string): ModuleManifestV0 | undefined {
  return MODULES.find((m) => m.id === id);
}

function owns(prefix: string, pathname: string): boolean {
  // Whole path segments only: "/api/myday" owns "/api/myday/templates" but
  // not "/api/mydays". "/" owns only "/" itself.
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** The module that owns a page or API path (longest matching prefix), if any. */
export function moduleForPath(pathname: string): ModuleManifestV0 | undefined {
  let best: ModuleManifestV0 | undefined;
  let bestLength = -1;
  for (const m of MODULES as readonly ModuleManifestV0[]) {
    for (const prefix of [...m.pages, ...m.api]) {
      if (prefix.length > bestLength && owns(prefix, pathname)) {
        best = m;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}

export type ModuleState = Record<string, boolean>;

/**
 * Apply on/off changes to a state of the toggleable modules, then keep
 * dependsOn true. Pure, so the wizard can show the result live and
 * src/lib/modules.ts can save exactly the same result.
 * - Turning a module on turns on what it depends on (rewards → routines).
 * - Turning a module off turns off what depends on it (routines → rewards,
 *   progress). If one change list asks for both, off wins.
 * - Any module left on whose dependency is off goes off.
 * Core and unknown ids are ignored.
 */
export function applyModuleChanges(current: ModuleState, changes: ModuleState): ModuleState {
  const next: ModuleState = {};
  for (const m of TOGGLEABLE_MODULES) next[m.id] = current[m.id] ?? m.defaultEnabled;
  const known = (id: string) => id in next;
  const turnOn = (id: string, seen = new Set<string>()) => {
    if (!known(id) || seen.has(id)) return;
    seen.add(id);
    next[id] = true;
    for (const dep of getModule(id)?.dependsOn ?? []) turnOn(dep, seen);
  };
  const turnOff = (id: string, seen = new Set<string>()) => {
    if (!known(id) || seen.has(id)) return;
    seen.add(id);
    next[id] = false;
    for (const m of TOGGLEABLE_MODULES) if (m.dependsOn?.includes(id)) turnOff(m.id, seen);
  };
  const entries = Object.entries(changes);
  for (const [id, on] of entries) if (on === true) turnOn(id);
  for (const [id, on] of entries) if (on === false) turnOff(id);
  for (const m of TOGGLEABLE_MODULES) {
    if (next[m.id] && (m.dependsOn ?? []).some((dep) => next[dep] === false)) turnOff(m.id);
  }
  return next;
}

/** The fresh-install state: every toggleable module at its default. */
export function defaultModuleState(): ModuleState {
  return Object.fromEntries(TOGGLEABLE_MODULES.map((m) => [m.id, m.defaultEnabled]));
}
