import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deckQuotes } from "@/components/Ambient";
import {
  HOLD_MAX_MS,
  isCurrentRev,
  isNewerRev,
  moduleStateAction,
  newerModuleState,
  todayAnswerAction,
  watcherHolds,
  type ModuleSnapshot,
} from "@/components/ModulesProvider";
import { GET as modulesGet } from "@/app/api/modules/route";
import { getDb } from "@/lib/db";
import { enabledModules, enabledTabs, modulesRev, setEnabled } from "@/lib/modules";

// The module state's revision (settings key modules_rev). Every save bumps it,
// and the screen shows the state with the highest revision, so a late
// /api/today answer can't put back what a newer save replaced.

const storedRev = () =>
  (getDb().prepare("SELECT value FROM settings WHERE key='modules_rev'").get() as { value: string } | undefined)?.value;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("newerModuleState (the provider's merge rule)", () => {
  const at = (rev: number, on: string[]): ModuleSnapshot => {
    const modules = ["core", ...on];
    return { rev, modules, tabs: enabledTabs(modules) };
  };
  const A = (rev: number) => at(rev, ["calendar", "routines", "meals", "lists"]);
  const B = (rev: number) => at(rev, ["calendar", "routines"]);

  it("layout A, poll B, save A, then a stale poll B arriving late: A is shown", () => {
    let shown = A(1); // the layout renders A
    shown = newerModuleState(shown, B(2)); // a Today poll returns B
    expect(shown).toEqual(B(2));
    shown = newerModuleState(shown, A(3)); // the parent saves A again
    expect(shown).toEqual(A(3));
    shown = newerModuleState(shown, A(3)); // router.refresh() re-renders the layout with A
    shown = newerModuleState(shown, B(2)); // the poll that left before the save lands last
    expect(shown).toEqual(A(3));
  });

  it("an equal revision keeps what is shown", () => {
    const shown = A(4);
    expect(newerModuleState(shown, B(4))).toBe(shown);
    expect(newerModuleState(shown, A(4))).toBe(shown);
  });
});

describe("isCurrentRev (the Today page keeps an answer's data or drops it)", () => {
  it("meals switched off at rev 3, then a poll read at rev 2 lands: its data is dropped", () => {
    let shownRev = 2; // the page shows an answer with today's meals
    shownRev = 3; // Settings saves meals off; the provider shows rev 3
    expect(isCurrentRev(shownRev, 2)).toBe(false); // the late poll still carries meals
    expect(isCurrentRev(shownRev, 3)).toBe(true); // the next poll, read after the save
  });

  it("takes an answer at the same or a higher revision", () => {
    expect(isCurrentRev(5, 5)).toBe(true);
    expect(isCurrentRev(5, 6)).toBe(true);
    expect(isCurrentRev(0, 0)).toBe(true);
  });

  it("drops an answer without a usable revision", () => {
    for (const rev of [undefined, null, "5", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isCurrentRev(0, rev)).toBe(false);
    }
  });
});

describe("isNewerRev (Settings → Modules applies a snapshot or keeps its switches)", () => {
  it("a save answer older than the switches shown is not applied", () => {
    let shownRev = -1; // nothing read yet
    expect(isNewerRev(shownRev, 4)).toBe(true); // the first read, at rev 4
    shownRev = 4;
    expect(isNewerRev(shownRev, 6)).toBe(true); // a save answered at rev 6
    shownRev = 6;
    expect(isNewerRev(shownRev, 5)).toBe(false); // an earlier save's answer, landing last
    expect(isNewerRev(shownRev, 6)).toBe(false); // the same revision again
  });

  it("never applies an answer without a usable revision", () => {
    for (const rev of [undefined, null, "7", Number.NaN]) expect(isNewerRev(-1, rev)).toBe(false);
  });

  it("the switches read again when the wall shows a newer state (Meals turned on elsewhere)", () => {
    const switchesRev = 4; // read at rev 4, Meals off
    let wallRev = 4;
    expect(isNewerRev(switchesRev, wallRev)).toBe(false); // nothing to read
    wallRev = 5; // the watcher synced another screen's "Meals on"
    expect(isNewerRev(switchesRev, wallRev)).toBe(true); // GET /api/settings/modules again
  });
});

describe("deckQuotes (the screensaver's quotes)", () => {
  const quotes = [
    { kind: "quote", text: "The secret of getting ahead is getting started.", attribution: "Mark Twain" },
    { kind: "rule", text: "We tell the truth." },
  ];

  it("leaves out Ask's quotes while Ask is off, even from a config read while it was on", () => {
    expect(deckQuotes(quotes, false)).toEqual([{ kind: "rule", text: "We tell the truth." }]);
  });

  it("keeps everything while Ask is on", () => {
    expect(deckQuotes(quotes, true)).toEqual(quotes);
  });
});

describe("modules_rev", () => {
  it("is 0 before any save", () => {
    getDb().prepare("DELETE FROM settings WHERE key='modules_rev'").run();
    expect(storedRev()).toBeUndefined();
    expect(modulesRev()).toBe(0);
  });

  it("setEnabled bumps it by one each time, stored as an integer string, even when nothing changes", () => {
    const before = modulesRev();
    setEnabled({ lists: false }, { actor: "parent" });
    expect(modulesRev()).toBe(before + 1);
    expect(storedRev()).toBe(String(before + 1));
    setEnabled({ lists: false }, { actor: "parent" });
    expect(modulesRev()).toBe(before + 2);
    setEnabled({ lists: true }, { actor: "setup" });
    expect(modulesRev()).toBe(before + 3);
    expect(enabledModules()).toContain("lists");
  });

  it("goes with the state: a save that fails inside the caller's transaction leaves both as they were", () => {
    const before = modulesRev();
    const db = getDb();
    expect(() =>
      db.transaction(() => {
        setEnabled({ meals: false }, { actor: "parent" });
        throw new Error("setup claim failed");
      })()
    ).toThrow("setup claim failed");
    expect(modulesRev()).toBe(before);
    expect(enabledModules()).toContain("meals");
  });
});

describe("todayAnswerAction (late answers versus a restored database)", () => {
  it("drops an answer that a newer save overtook while it was on its way", () => {
    // Shown rev 2 when the poll started; a save to rev 3 landed meanwhile.
    expect(todayAnswerAction(2, 3, 2)).toBe("drop");
  });

  it("takes an answer at or above the revision shown now", () => {
    expect(todayAnswerAction(2, 3, 3)).toBe("take");
    expect(todayAnswerAction(3, 3, 4)).toBe("take");
  });

  it("reloads when the server's revision went backwards since the request started (a restore)", () => {
    // Shown rev 7 at the start; the restored database is at rev 2.
    expect(todayAnswerAction(7, 7, 2)).toBe("reload");
  });

  it("drops an answer without a revision", () => {
    for (const rev of [undefined, null, "3", Number.NaN]) expect(todayAnswerAction(0, 0, rev)).toBe("drop");
  });
});

describe("moduleStateAction (one rule for the watcher, /api/today, a Settings save and the layout)", () => {
  const at = (rev: number, on: string[]): ModuleSnapshot => {
    const modules = ["core", ...on];
    return { rev, modules, tabs: enabledTabs(modules) };
  };
  const ALL = ["calendar", "routines", "rewards", "progress", "reading", "meals", "lists"];
  const without = (...off: string[]) => ALL.filter((m) => !off.includes(m));

  it("reloads when a module shown as on is off at a newer revision", () => {
    expect(moduleStateAction(at(4, ALL), at(5, without("reading")))).toBe("reload");
    // Routines off takes rewards and progress with it: still one reload.
    expect(moduleStateAction(at(4, ALL), at(9, without("routines", "rewards", "progress")))).toBe("reload");
  });

  it("reloads when one module went on and another off at the newer revision", () => {
    expect(moduleStateAction(at(4, without("ask")), at(5, [...without("meals"), "ask"]))).toBe("reload");
  });

  it("syncs without a reload when modules were only turned on", () => {
    expect(moduleStateAction(at(4, without("meals")), at(5, ALL))).toBe("sync");
    expect(moduleStateAction(at(4, ALL), at(6, [...ALL, "ask"]))).toBe("sync");
    // A save that changed nothing still bumps the revision.
    expect(moduleStateAction(at(4, ALL), at(5, ALL))).toBe("sync");
  });

  it("reloads when the server's revision is lower than the one shown (a restored database)", () => {
    expect(moduleStateAction(at(7, ALL), at(2, ALL))).toBe("reload");
    expect(moduleStateAction(at(7, without("lists")), at(0, ALL))).toBe("reload");
  });

  it("does nothing at the same revision with the same modules, in any order", () => {
    expect(moduleStateAction(at(5, ALL), at(5, ALL))).toBe("none");
    expect(moduleStateAction(at(5, ALL), at(5, [...ALL].reverse()))).toBe("none");
  });

  it("reloads at the same revision with other modules (a restore that came back to the revision shown)", () => {
    // A restore to rev 3, then a save that turned Meals off and Ask on: the
    // server is back at the shown rev 5 with another module set.
    expect(moduleStateAction(at(5, ALL), at(5, [...without("meals"), "ask"]))).toBe("reload");
    // Only turned on, at the same revision: a restore too.
    expect(moduleStateAction(at(5, without("lists")), at(5, ALL))).toBe("reload");
    // However the answer was started.
    expect(moduleStateAction(at(5, ALL), at(5, without("meals")), 5)).toBe("reload");
    expect(moduleStateAction(at(5, ALL), at(5, without("meals")), Number.NEGATIVE_INFINITY)).toBe("reload");
  });

  it("does nothing with an answer read before a newer state reached the screen (late, not a restore)", () => {
    // The check left at rev 4; a Settings save on this screen (or a Today
    // poll) showed rev 5 before the answer, read at rev 4, came back.
    expect(moduleStateAction(at(5, without("meals")), at(4, ALL), 4)).toBe("none");
    // Read below the revision shown when it left: the database went back.
    expect(moduleStateAction(at(5, without("meals")), at(3, ALL), 4)).toBe("reload");
  });

  it("a state with no known start (the layout): a lower revision is late, the rest as for the watcher", () => {
    const shown = at(5, ALL);
    const unknown = Number.NEGATIVE_INFINITY;
    expect(moduleStateAction(shown, at(4, without("meals")), unknown)).toBe("none");
    expect(moduleStateAction(shown, at(0, ALL), unknown)).toBe("none");
    expect(moduleStateAction(shown, at(6, without("meals")), unknown)).toBe("reload");
    expect(moduleStateAction(shown, at(6, [...ALL, "ask"]), unknown)).toBe("sync");
  });

  it("an old /api/today answer handed over after the page changed: a module it turned off reloads", () => {
    // Today's poll left at rev 4 and lands at rev 6 with Lists off while the
    // wall shows Lists at rev 4: the provider reloads instead of quietly
    // moving to rev 6, which the next watcher check would then see as current.
    expect(moduleStateAction(at(4, ALL), at(6, without("lists")), 4)).toBe("reload");
    // Settings' own save, answered after its hold ran out, goes the same way.
    expect(moduleStateAction(at(4, ALL), at(5, without("reading")), 4)).toBe("reload");
  });

  it("does nothing after a failed check or an answer without a usable revision", () => {
    const shown = at(5, ALL);
    for (const server of [null, undefined, "5", {}, { error: "Unlock this screen with the parent PIN" }]) {
      expect(moduleStateAction(shown, server)).toBe("none");
    }
    for (const rev of [undefined, null, "6", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(moduleStateAction(shown, { rev, modules: ["core"], tabs: [] })).toBe("none");
    }
    // A revision but no usable module list.
    expect(moduleStateAction(shown, { rev: 6, tabs: [] })).toBe("none");
    expect(moduleStateAction(shown, { rev: 6, modules: "core", tabs: [] })).toBe("none");
    expect(moduleStateAction(shown, { rev: 6, modules: [1, 2], tabs: [] })).toBe("none");
    expect(moduleStateAction(shown, { rev: 6, modules: ["core"] })).toBe("none");
  });
});

describe("watcherHolds (Settings holds the watcher while its save is on its way)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a stalled save's hold ends by itself after HOLD_MAX_MS, and the watcher checks at once", () => {
    const check = vi.fn();
    const holds = watcherHolds();
    holds.whenIdle(check);
    holds.hold(); // the save never answers, and nothing calls release
    expect(holds.held()).toBe(true);
    vi.advanceTimersByTime(HOLD_MAX_MS - 1);
    expect(holds.held()).toBe(true);
    expect(check).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(holds.held()).toBe(false);
    expect(check).toHaveBeenCalledTimes(1);
    expect(HOLD_MAX_MS).toBeLessThanOrEqual(15_000);
  });

  it("released early (the save answered, or the card unmounted): checks at once, once, and the timer does nothing later", () => {
    const check = vi.fn();
    const holds = watcherHolds();
    holds.whenIdle(check);
    const release = holds.hold();
    vi.advanceTimersByTime(2000);
    release();
    expect(holds.held()).toBe(false);
    expect(check).toHaveBeenCalledTimes(1);
    release(); // the save's finally after the unmount cleanup already released it
    vi.advanceTimersByTime(HOLD_MAX_MS * 2);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("checks only when the last hold ends", () => {
    const check = vi.fn();
    const holds = watcherHolds();
    holds.whenIdle(check);
    const first = holds.hold();
    vi.advanceTimersByTime(10_000);
    const second = holds.hold();
    first();
    expect(holds.held()).toBe(true);
    expect(check).not.toHaveBeenCalled();
    // The first hold's timer was cleared; the second runs out on its own.
    vi.advanceTimersByTime(HOLD_MAX_MS - 1);
    expect(check).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(check).toHaveBeenCalledTimes(1);
    second();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("a hold after the last one ended starts over", () => {
    const check = vi.fn();
    const holds = watcherHolds(1000);
    holds.whenIdle(check);
    holds.hold()();
    holds.hold();
    expect(holds.held()).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("a watcher that stopped (the provider unmounted) is not called", () => {
    const check = vi.fn();
    const holds = watcherHolds();
    const stop = holds.whenIdle(check);
    holds.hold();
    stop();
    vi.advanceTimersByTime(HOLD_MAX_MS);
    expect(holds.held()).toBe(false);
    expect(check).not.toHaveBeenCalled();
  });
});

describe("GET /api/modules (what the watcher reads)", () => {
  it("answers the same revision, ids and tab bar as the layout and /api/today, and follows a save", async () => {
    setEnabled({ meals: true, lists: true }, { actor: "parent" });
    const before = await modulesGet().json();
    const on = enabledModules();
    expect(before).toEqual({ rev: modulesRev(), modules: on, tabs: enabledTabs(on) });
    expect(before.modules).toContain("meals");
    setEnabled({ meals: false }, { actor: "parent" });
    const after = await modulesGet().json();
    expect(after.rev).toBe(before.rev + 1);
    expect(after.modules).not.toContain("meals");
    expect(after.tabs.map((t: { id: string }) => t.id)).not.toContain("meals");
    // The watcher on a screen still showing `before` reloads.
    expect(moduleStateAction(before, after)).toBe("reload");
  });

  it("is never cached", () => {
    expect(modulesGet().headers.get("cache-control")).toBe("no-store");
  });
});
