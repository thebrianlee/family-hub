"use client";

// Which built-in modules are on, for client components (src/modules/registry.ts
// lists them). The root layout reads the state on every page load and passes
// it here. A wall that stays open for days also picks up the state from each
// /api/today answer (its `modules`, `tabs` and `modulesRev` fields), and
// Settings → Modules hands over the state its save returned, then re-renders
// the layout. Every state carries its revision (src/lib/modules.ts
// modulesRev) and the newest one is shown, wherever it came from, so an
// answer that arrives late never puts back an older state. A screen that keeps
// data from such an answer checks it against `rev` too (isCurrentRev). The
// real gate is on the server (src/proxy.ts): this only keeps the screen from
// showing links to what is switched off.

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { getModule } from "@/modules/registry";

export type TabInfo = { id: string; href: string; label: string };

/** One reading of the module state, with its revision. */
export type ModuleSnapshot = { rev: number; modules: string[]; tabs: TabInfo[] };

/**
 * The state to show once `next` arrives: `next` only when its revision is
 * higher than the one shown; on an equal or lower revision, what is shown
 * stays. Pure, so the rule is tested on its own.
 */
export function newerModuleState(current: ModuleSnapshot, next: ModuleSnapshot): ModuleSnapshot {
  return next.rev > current.rev ? next : current;
}

/**
 * Whether an answer read at module revision `rev` may be used while the screen
 * shows revision `shownRev`: yes at the same or a higher revision, no at a
 * lower one (it was read before a newer save, so it can still carry a module
 * that has since been switched off) or without a revision. The Today page
 * drops such an answer whole and keeps what it shows.
 */
export function isCurrentRev(shownRev: number, rev: unknown): rev is number {
  return typeof rev === "number" && Number.isFinite(rev) && rev >= shownRev;
}

/**
 * Whether a saved state at revision `rev` replaces one shown at `shownRev`:
 * only when it is newer, as in newerModuleState. Settings → Modules uses it
 * for its own switch positions.
 */
export function isNewerRev(shownRev: number, rev: unknown): rev is number {
  return typeof rev === "number" && Number.isFinite(rev) && rev > shownRev;
}

type Modules = {
  isOn: (id: string) => boolean;
  /** The revision of the module state shown. */
  rev: number;
  tabs: TabInfo[];
  /** A module state from /api/today or a Settings save; shown only if it is newer. */
  syncModules: (state: ModuleSnapshot) => void;
};

// Outside the provider (only the setup screen, which doesn't ask) nothing is hidden.
const ModulesContext = createContext<Modules>({ isOn: () => true, rev: 0, tabs: [], syncModules: () => {} });

export default function ModulesProvider({
  rev,
  enabled,
  tabs,
  children,
}: {
  rev: number;
  enabled: string[];
  tabs: TabInfo[];
  children: React.ReactNode;
}) {
  const [shown, setShown] = useState<ModuleSnapshot>(() => ({ rev, modules: enabled, tabs }));
  // New props from the layout (router.refresh() keeps this state) go through
  // the same rule as the other sources.
  const fromLayout = JSON.stringify({ rev, modules: enabled, tabs });
  const [seenLayout, setSeenLayout] = useState(fromLayout);
  if (seenLayout !== fromLayout) {
    setSeenLayout(fromLayout);
    setShown((prev) => newerModuleState(prev, { rev, modules: enabled, tabs }));
  }

  const syncModules = useCallback((next: ModuleSnapshot) => {
    setShown((prev) => newerModuleState(prev, next));
  }, []);

  const value = useMemo<Modules>(() => {
    const isOn = (id: string): boolean => {
      const m = getModule(id);
      if (!m) return false;
      if (m.core) return true;
      return shown.modules.includes(id) && (m.dependsOn ?? []).every(isOn);
    };
    return { isOn, rev: shown.rev, tabs: shown.tabs, syncModules };
  }, [shown, syncModules]);

  return <ModulesContext.Provider value={value}>{children}</ModulesContext.Provider>;
}

export function useModules(): Modules {
  return useContext(ModulesContext);
}
