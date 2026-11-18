"use client";

// Which built-in modules are on, for client components (src/modules/registry.ts
// lists them). The root layout reads the state on every page load and passes
// it here. A wall that stays open for days also picks up the state from each
// /api/today answer (its `modules`, `tabs` and `modulesRev` fields), and
// Settings → Modules hands over the state its save returned, then re-renders
// the layout. Every state carries its revision (src/lib/modules.ts
// modulesRev) and the newest one is shown, wherever it came from, so an
// answer that arrives late never puts back an older state. A screen that keeps
// data from such an answer checks it against `rev` too (todayAnswerAction).
//
// The module watcher, on every screen: GET /api/modules every minute, on each
// sproutwall:datachanged event and when the tab is shown again. A module
// switched off elsewhere reloads the page (watcherAction), which clears every
// screen's data, any open sheet and Ambient at once, so no screen has to clear
// a module's leftovers on its own. A module switched on is just shown. The
// screen that saves the change (Settings → Modules) applies its own answer and
// does not reload. The real gate is on the server (src/proxy.ts, and
// src/lib/module-fetch.ts for outside requests): this only keeps the screen
// from showing what is switched off.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
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
 * What the Today page does with an answer read at module revision `rev`:
 * - "take" it when `rev` is at least the revision shown now;
 * - "drop" it when it is lower than the one shown now but not lower than the
 *   one shown when the request started: a newer save landed while the answer
 *   was on its way, so it can still carry a module that is now off;
 * - "reload" the screen when it is lower than the revision shown when the
 *   request started: the server's revision went backwards, which means its
 *   database was replaced (a restore from a backup). Only a full reload
 *   brings every part of the screen back in line with it;
 * - "drop" an answer without a revision.
 */
export function todayAnswerAction(revAtStart: number, shownRev: number, rev: unknown): "take" | "drop" | "reload" {
  if (typeof rev !== "number" || !Number.isFinite(rev)) return "drop";
  if (rev < revAtStart) return "reload";
  return rev >= shownRev ? "take" : "drop";
}

/**
 * Whether a saved state at revision `rev` replaces one shown at `shownRev`:
 * only when it is newer, as in newerModuleState. Settings → Modules uses it
 * for its own switch positions.
 */
export function isNewerRev(shownRev: number, rev: unknown): rev is number {
  return typeof rev === "number" && Number.isFinite(rev) && rev > shownRev;
}

function isSnapshot(v: unknown): v is ModuleSnapshot {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Partial<ModuleSnapshot>;
  return (
    typeof s.rev === "number" &&
    Number.isFinite(s.rev) &&
    Array.isArray(s.modules) &&
    s.modules.every((id) => typeof id === "string") &&
    Array.isArray(s.tabs)
  );
}

/**
 * What the module watcher does with the server's module state (GET
 * /api/modules) while the screen shows `shown`. `revAtStart` is the revision
 * shown when the request left; it defaults to the one shown now.
 * - "reload" when the server's revision is lower than the one shown when the
 *   request left: its database was replaced (a restore from a backup);
 * - "reload" when it is higher and a module shown as on is off there: only a
 *   full reload clears every screen's data, open sheets and Ambient;
 * - "sync" when it is higher and modules were only turned on: shown at once
 *   (syncModules), no reload;
 * - "none" otherwise: the same revision; an answer read before a newer state
 *   reached this screen while it was on its way (a Settings save or a Today
 *   poll), which is late, not a restore; a failed request; no revision.
 */
export function watcherAction(shown: ModuleSnapshot, server: unknown, revAtStart = shown.rev): "reload" | "sync" | "none" {
  if (!isSnapshot(server)) return "none";
  if (server.rev < Math.min(revAtStart, shown.rev)) return "reload";
  if (server.rev <= shown.rev) return "none";
  return shown.modules.some((id) => !server.modules.includes(id)) ? "reload" : "sync";
}

/** How often the watcher checks when nothing else prompts it. */
const WATCH_MS = 60_000;

type Modules = {
  isOn: (id: string) => boolean;
  /** The revision of the module state shown. */
  rev: number;
  tabs: TabInfo[];
  /** A module state from /api/today or a Settings save; shown only if it is newer. */
  syncModules: (state: ModuleSnapshot) => void;
  /**
   * For Settings → Modules while its save is on its way: the watcher ignores
   * what it reads until the returned function is called, because the save's
   * own answer (syncModules) is what this screen shows. Without it, a check
   * that read the new state first would reload the screen that saved it.
   */
  holdWatcher: () => () => void;
};

// Outside the provider (only the setup screen, which doesn't ask) nothing is hidden.
const ModulesContext = createContext<Modules>({
  isOn: () => true,
  rev: 0,
  tabs: [],
  syncModules: () => {},
  holdWatcher: () => () => {},
});

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

  // What the watcher compares with: the state shown, ahead of the next render
  // when syncModules has just been called.
  const shownRef = useRef(shown);
  useEffect(() => {
    shownRef.current = newerModuleState(shownRef.current, shown);
  }, [shown]);
  const holds = useRef(0);

  const syncModules = useCallback((next: ModuleSnapshot) => {
    shownRef.current = newerModuleState(shownRef.current, next);
    setShown((prev) => newerModuleState(prev, next));
  }, []);

  const holdWatcher = useCallback(() => {
    holds.current++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holds.current--;
    };
  }, []);

  // The module watcher (see the top of this file).
  useEffect(() => {
    let live = true;
    const check = () => {
      const revAtStart = shownRef.current.rev;
      void fetch("/api/modules", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .then((server: unknown) => {
          if (!live || holds.current > 0) return;
          const action = watcherAction(shownRef.current, server, revAtStart);
          if (action === "reload") window.location.reload();
          else if (action === "sync") syncModules(server as ModuleSnapshot);
        });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    const timer = window.setInterval(check, WATCH_MS);
    window.addEventListener("sproutwall:datachanged", check);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener("sproutwall:datachanged", check);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [syncModules]);

  const value = useMemo<Modules>(() => {
    const isOn = (id: string): boolean => {
      const m = getModule(id);
      if (!m) return false;
      if (m.core) return true;
      return shown.modules.includes(id) && (m.dependsOn ?? []).every(isOn);
    };
    return { isOn, rev: shown.rev, tabs: shown.tabs, syncModules, holdWatcher };
  }, [shown, syncModules, holdWatcher]);

  return <ModulesContext.Provider value={value}>{children}</ModulesContext.Provider>;
}

export function useModules(): Modules {
  return useContext(ModulesContext);
}
