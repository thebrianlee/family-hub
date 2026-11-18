"use client";

// Which built-in modules are on, for client components (src/modules/registry.ts
// lists them). The root layout reads the state on every page load and passes
// it here. A wall that stays open for days also picks up the tab list from
// each /api/today answer (its `tabs` field), and Settings → Modules re-renders
// the layout after a change. The real gate is on the server (src/proxy.ts):
// this only keeps the screen from showing links to what is switched off.

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { getModule } from "@/modules/registry";

export type TabInfo = { id: string; href: string; label: string };

type Modules = {
  isOn: (id: string) => boolean;
  tabs: TabInfo[];
  /** The tab list from a newer /api/today answer. */
  syncTabs: (tabs: TabInfo[]) => void;
};

// Outside the provider (only the setup screen, which doesn't ask) nothing is hidden.
const ModulesContext = createContext<Modules>({ isOn: () => true, tabs: [], syncTabs: () => {} });

export default function ModulesProvider({
  enabled,
  tabs,
  children,
}: {
  enabled: string[];
  tabs: TabInfo[];
  children: React.ReactNode;
}) {
  // Tabs from /api/today, kept only until the layout sends newer props.
  const base = JSON.stringify(tabs);
  const [live, setLive] = useState<{ base: string; tabs: TabInfo[] } | null>(null);
  const current = live && live.base === base ? live.tabs : tabs;

  const syncTabs = useCallback(
    (next: TabInfo[]) => {
      setLive((prev) => {
        const shown = prev && prev.base === base ? prev.tabs : JSON.parse(base);
        return JSON.stringify(shown) === JSON.stringify(next) ? prev : { base, tabs: next };
      });
    },
    [base]
  );

  const value = useMemo<Modules>(() => {
    const fromToday = live !== null && live.base === base;
    const isOn = (id: string): boolean => {
      const m = getModule(id);
      if (!m) return false;
      if (m.core) return true;
      // A module with a tab: a newer /api/today answer knows best.
      const on = m.tab && fromToday ? current.some((t) => t.id === id) : enabled.includes(id);
      return on && (m.dependsOn ?? []).every(isOn);
    };
    return { isOn, tabs: current, syncTabs };
  }, [enabled, current, live, base, syncTabs]);

  return <ModulesContext.Provider value={value}>{children}</ModulesContext.Provider>;
}

export function useModules(): Modules {
  return useContext(ModulesContext);
}
