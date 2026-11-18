"use client";

// Which built-in modules are on, for client components (src/modules/registry.ts
// lists them). The root layout reads the state on every page load and passes
// it here. A wall that stays open for days also picks up the state from each
// /api/today answer (its `modules` and `tabs` fields), and Settings → Modules
// re-renders the layout after a change. The real gate is on the server
// (src/proxy.ts): this only keeps the screen from showing links to what is
// switched off.

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { getModule } from "@/modules/registry";

export type TabInfo = { id: string; href: string; label: string };

type Modules = {
  isOn: (id: string) => boolean;
  tabs: TabInfo[];
  /** The module state from a newer /api/today answer. */
  syncModules: (state: { modules: string[]; tabs: TabInfo[] }) => void;
};

// Outside the provider (only the setup screen, which doesn't ask) nothing is hidden.
const ModulesContext = createContext<Modules>({ isOn: () => true, tabs: [], syncModules: () => {} });

export default function ModulesProvider({
  enabled,
  tabs,
  children,
}: {
  enabled: string[];
  tabs: TabInfo[];
  children: React.ReactNode;
}) {
  // State from /api/today, kept only until the layout sends newer props.
  const base = JSON.stringify({ modules: enabled, tabs });
  const [live, setLive] = useState<{ base: string; modules: string[]; tabs: TabInfo[] } | null>(null);
  const fromToday = live !== null && live.base === base;
  const currentModules = fromToday ? live.modules : enabled;
  const current = fromToday ? live.tabs : tabs;

  const syncModules = useCallback(
    (next: { modules: string[]; tabs: TabInfo[] }) => {
      setLive((prev) => {
        const shown = prev && prev.base === base ? JSON.stringify({ modules: prev.modules, tabs: prev.tabs }) : base;
        const incoming = JSON.stringify({ modules: next.modules, tabs: next.tabs });
        return shown === incoming ? prev : { base, modules: next.modules, tabs: next.tabs };
      });
    },
    [base]
  );

  const value = useMemo<Modules>(() => {
    const isOn = (id: string): boolean => {
      const m = getModule(id);
      if (!m) return false;
      if (m.core) return true;
      return currentModules.includes(id) && (m.dependsOn ?? []).every(isOn);
    };
    return { isOn, tabs: current, syncModules };
  }, [currentModules, current, syncModules]);

  return <ModulesContext.Provider value={value}>{children}</ModulesContext.Provider>;
}

export function useModules(): Modules {
  return useContext(ModulesContext);
}
