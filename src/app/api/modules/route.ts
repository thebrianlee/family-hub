import { NextResponse } from "next/server";

import { enabledModules, enabledTabs, modulesRev } from "@/lib/modules";

export const dynamic = "force-dynamic";

// The module state every screen checks (components/ModulesProvider.tsx, the
// module watcher): the same revision, ids and tab bar as /api/today and the
// root layout. Core, so a module switched off never hides it; behind the same
// read lock as every other route (src/proxy.ts).
export function GET() {
  const modules = enabledModules();
  return NextResponse.json(
    { rev: modulesRev(), modules, tabs: enabledTabs(modules) },
    { headers: { "cache-control": "no-store" } }
  );
}
