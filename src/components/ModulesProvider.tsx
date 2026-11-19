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
// sproutwall:datachanged event and when the tab is shown again.
//
// One rule (moduleStateAction) for every module state that reaches the
// provider: the watcher's, a /api/today answer, a Settings save and the
// layout. A module switched off reloads the page, which clears every screen's
// data, any open sheet and Ambient at once, so no screen has to clear a
// module's leftovers on its own; so does a restored database, whether its
// revision went back or came back to the one shown with other modules. A
// module switched on is just shown. The one exception: while Settings →
// Modules holds the watcher for its save, the state it hands over is shown
// without a reload, so the screen that saves the change does not reload
// itself. A hold ends after HOLD_MAX_MS at the latest, and the watcher checks
// at once when the last one ends. The real gate is on the server
// (src/proxy.ts, and src/lib/module-fetch.ts for outside requests): this only
// keeps the screen from showing what is switched off.

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

/** The same module ids, in any order. */
function sameModules(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a);
  return set.size === new Set(b).size && b.every((id) => set.has(id));
}

/**
 * What the screen does with a module state `next` that reaches the provider
 * while it shows `shown`: the watcher's GET /api/modules, a /api/today
 * answer, a Settings save or the layout. `revAtStart` is the revision shown
 * when the request for `next` left; it defaults to the one shown now. Pass
 * -Infinity when it is not known (the layout): a lower revision is then
 * taken as late, and the watcher still catches a restore.
 * - "reload" when the revision is lower than the one shown when the request
 *   left: the database was replaced (a restore from a backup);
 * - "none" when it is lower than the one shown now but not than that: read
 *   before a newer state reached this screen while it was on its way, which
 *   is late, not a restore;
 * - "reload" at the same revision with other modules: a restore that came
 *   back to the revision shown (each revision has one module set);
 * - "none" at the same revision with the same modules;
 * - "reload" when it is higher and a module shown as on is off there: only a
 *   full reload clears every screen's data, open sheets and Ambient;
 * - "sync" when it is higher and modules were only turned on (or none
 *   changed): shown at once, no reload;
 * - "none" for anything that is not a module state (a failed request, no
 *   revision, no module list).
 */
export function moduleStateAction(shown: ModuleSnapshot, next: unknown, revAtStart = shown.rev): "reload" | "sync" | "none" {
  if (!isSnapshot(next)) return "none";
  if (next.rev < Math.min(revAtStart, shown.rev)) return "reload";
  if (next.rev < shown.rev) return "none";
  if (next.rev === shown.rev) return sameModules(shown.modules, next.modules) ? "none" : "reload";
  return shown.modules.some((id) => !next.modules.includes(id)) ? "reload" : "sync";
}

/** How often the watcher checks when nothing else prompts it. */
const WATCH_MS = 60_000;

/** The longest one hold keeps the watcher waiting, whatever happens to the save. */
export const HOLD_MAX_MS = 15_000;

export type WatcherHolds = {
  /** Whether any hold is active. */
  held: () => boolean;
  /** Start a hold; the returned function ends it (calling it again does nothing). */
  hold: () => () => void;
  /** Run `fn` each time the last hold ends; returns a function that stops it. */
  whenIdle: (fn: () => void) => () => void;
};

/**
 * The holds on the module watcher (Settings → Modules while its save is on
 * its way). A hold ends when its release is called (the save is done, or the
 * card unmounts) or after `maxMs` at the latest, so a stalled save can't keep
 * the watcher waiting. When the last hold ends, the whenIdle functions run
 * once: the watcher checks at once, so a check skipped while held is not
 * lost. No React, so it is tested with fake timers.
 */
export function watcherHolds(maxMs = HOLD_MAX_MS): WatcherHolds {
  let count = 0;
  const idle = new Set<() => void>();
  return {
    held: () => count > 0,
    hold: () => {
      count++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        clearTimeout(timer);
        count--;
        if (count === 0) for (const fn of [...idle]) fn();
      };
      const timer = setTimeout(release, maxMs);
      return release;
    },
    whenIdle: (fn) => {
      idle.add(fn);
      return () => {
        idle.delete(fn);
      };
    },
  };
}

type Modules = {
  isOn: (id: string) => boolean;
  /** The revision of the module state shown. */
  rev: number;
  tabs: TabInfo[];
  /**
   * A module state from /api/today or a Settings save, with the revision
   * shown when its request left. Goes through moduleStateAction like the
   * watcher's: a module switched off reloads the page, except while the
   * watcher is held.
   */
  syncModules: (state: ModuleSnapshot, revAtStart?: number) => void;
  /**
   * For Settings → Modules while its save is on its way: until the returned
   * function is called (or HOLD_MAX_MS has passed) the watcher waits and the
   * state handed to syncModules is shown without a reload, because the
   * save's own answer is what this screen shows. Without it, a check that
   * read the new state first would reload the screen that saved it.
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
  // What every decision compares with: the state shown, ahead of the next
  // render when one has just been applied.
  const shownRef = useRef(shown);
  const show = useCallback((next: ModuleSnapshot) => {
    shownRef.current = newerModuleState(shownRef.current, next);
    setShown((prev) => newerModuleState(prev, next));
  }, []);

  const [holds] = useState(() => watcherHolds());

  // Every module state that reaches the provider goes through here.
  const apply = useCallback(
    (next: unknown, revAtStart?: number) => {
      if (holds.held()) {
        // Settings → Modules is saving: it shows its own answer.
        if (isSnapshot(next)) show(next);
        return;
      }
      const action = moduleStateAction(shownRef.current, next, revAtStart);
      if (action === "reload") window.location.reload();
      else if (action === "sync") show(next as ModuleSnapshot);
    },
    [holds, show]
  );

  const syncModules = useCallback((next: ModuleSnapshot, revAtStart?: number) => apply(next, revAtStart), [apply]);

  // New props from the layout (router.refresh() keeps this state) go through
  // the same rule. Nothing says when their request left, so a lower revision
  // counts as late; the watcher still catches a restore.
  const fromLayout = JSON.stringify({ rev, modules: enabled, tabs });
  useEffect(() => {
    apply(JSON.parse(fromLayout), Number.NEGATIVE_INFINITY);
  }, [fromLayout, apply]);

  // The module watcher (see the top of this file).
  useEffect(() => {
    let live = true;
    const check = () => {
      // Held: the end of the last hold checks again.
      if (holds.held()) return;
      const revAtStart = shownRef.current.rev;
      void fetch("/api/modules", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .then((server: unknown) => {
          // Read while a save was on its way: skipped, and checked again
          // when the hold ends.
          if (!live || holds.held()) return;
          apply(server, revAtStart);
        });
    };
    // When the last hold ends, at once.
    const stopIdle = holds.whenIdle(check);
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    const timer = window.setInterval(check, WATCH_MS);
    window.addEventListener("sproutwall:datachanged", check);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      stopIdle();
      window.clearInterval(timer);
      window.removeEventListener("sproutwall:datachanged", check);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [apply, holds]);

  const value = useMemo<Modules>(() => {
    const isOn = (id: string): boolean => {
      const m = getModule(id);
      if (!m) return false;
      if (m.core) return true;
      return shown.modules.includes(id) && (m.dependsOn ?? []).every(isOn);
    };
    return { isOn, rev: shown.rev, tabs: shown.tabs, syncModules, holdWatcher: holds.hold };
  }, [shown, syncModules, holds]);

  return <ModulesContext.Provider value={value}>{children}</ModulesContext.Provider>;
}

export function useModules(): Modules {
  return useContext(ModulesContext);
}
