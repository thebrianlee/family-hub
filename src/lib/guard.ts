import { NextRequest, NextResponse } from "next/server";

import { attemptPin } from "./pin-attempts";
import { PARENT_COOKIE, verifyCookie } from "./session";

// Route-level checks for parent actions. src/proxy.ts refuses every write that
// lacks a parent cookie (outside the kid allowlist); parent routes check again
// here so a matcher change can't silently remove that protection. Reads are
// gated by the proxy alone: it runs on every path except static assets.

export function hasParentCookie(req: NextRequest): boolean {
  return verifyCookie(req.cookies.get(PARENT_COOKIE)?.value, "parent");
}

/** A parent action is allowed with a valid parent cookie, or the PIN in the body. */
export function isParent(req: NextRequest, body?: { pin?: unknown }): boolean {
  if (hasParentCookie(req)) return true;
  return typeof body?.pin === "string" && attemptPin(req, body.pin).ok;
}

export function parentRequired(): NextResponse {
  return NextResponse.json({ error: "Parent PIN required" }, { status: 403 });
}
