import { NextRequest, NextResponse } from "next/server";

import { hasParentCookie, parentRequired } from "@/lib/guard";
import { enabledModules, enabledTabs, moduleStates, modulesRev, parseModuleChanges, setEnabled } from "@/lib/modules";
import { TOGGLEABLE_MODULES } from "@/modules/registry";

export const dynamic = "force-dynamic";

// Settings → Modules. Parent-only both ways: reading and writing need the
// parent cookie, which the parent gets by entering the PIN (skills.md:
// enabling needs the PIN). The proxy refuses a write without that cookie
// before this route runs, so a PIN in the body is not a second way in.
// Turning a module off only hides it; no data is deleted.

function snapshot() {
  const state = moduleStates();
  return {
    modules: TOGGLEABLE_MODULES.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      enabled: state[m.id],
      dependsOn: m.dependsOn ?? [],
      network: m.permissions.network,
      sendsChildDataTo: m.sendsChildDataTo,
    })),
  };
}

export async function GET(req: NextRequest) {
  if (!hasParentCookie(req)) return parentRequired();
  return NextResponse.json(snapshot());
}

// { modules: { [id]: boolean } }
// Answers with the snapshot, plus what the wall needs to follow the change
// at once: the new revision, the ids that are on (core included; `enabled`,
// because `modules` is the snapshot's list) and the tab bar.
export async function PUT(req: NextRequest) {
  if (!hasParentCookie(req)) return parentRequired();
  const body = await req.json().catch(() => ({}));
  const checked = parseModuleChanges(body?.modules);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
  setEnabled(checked.changes, { actor: "parent" });
  const enabled = enabledModules();
  return NextResponse.json({ ok: true, ...snapshot(), rev: modulesRev(), enabled, tabs: enabledTabs(enabled) });
}
