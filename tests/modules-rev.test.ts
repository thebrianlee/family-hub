import { beforeEach, describe, expect, it, vi } from "vitest";

import { newerModuleState, type ModuleSnapshot } from "@/components/ModulesProvider";
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
