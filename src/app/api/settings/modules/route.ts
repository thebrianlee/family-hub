import { NextRequest, NextResponse } from "next/server";

import { hasParentCookie, isParent, parentRequired } from "@/lib/guard";
import { moduleStates, parseModuleChanges, setEnabled } from "@/lib/modules";
import { TOGGLEABLE_MODULES } from "@/modules/registry";

export const dynamic = "force-dynamic";

// Settings → Modules. Parent-only both ways: reading needs the parent cookie,
// writing needs the cookie or the PIN (skills.md: enabling needs the PIN).
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

// { modules: { [id]: boolean }, pin? }
export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (!isParent(req, body)) return parentRequired();
  const checked = parseModuleChanges(body?.modules);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
  setEnabled(checked.changes, { actor: "parent" });
  return NextResponse.json({ ok: true, ...snapshot() });
}
