import { NextRequest, NextResponse } from "next/server";

import { isDbBlocked } from "@/lib/db";
import { DEVICE_COOKIE, PARENT_COOKIE, readsLocked, setupComplete, verifyCookie } from "@/lib/session";

// Access policy for every request. Routes repeat the parent checks themselves
// (src/lib/guard.ts), so this file is the first layer, not the only one.
//
// - Writes (non-GET /api) must come from this site: Origin must match Host.
//   A missing Origin is refused too; browsers always send it on fetch POSTs.
// - Before first-run setup there is nothing to protect, so the setup screen
//   and /api/setup are open. After setup, /api/setup refuses (409).
// - REQUIRE_AUTH_FOR_READS=1: every page, API and image needs a device or
//   parent cookie, except the unlock page, PIN submit and the health check.
// - Writes are parent-only by default. KID_WRITES lists the routes a kid may
//   use from an unlocked screen; inside them, parent-only actions (redeem,
//   event delete, removing an activity) are checked by the route.

const KID_WRITES = new Set([
  "/api/myday",
  "/api/myday/templates",
  "/api/lists",
  "/api/events",
  "/api/meals",
  "/api/reading",
  "/api/levelup",
  "/api/balance",
  "/api/ask",
]);
const BOOTSTRAP = new Set(["/api/pin", "/api/setup", "/api/health"]);
const PUBLIC_PAGES = new Set(["/unlock"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function refuse(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status });
}

export function sameOrigin(req: NextRequest): boolean {
  if (req.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = req.headers.get("origin");
  if (!origin) return false;
  // Behind a chain of proxies X-Forwarded-Host can be a list; the first entry
  // is the host the browser asked for.
  const forwarded = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwarded || req.headers.get("host");
  try {
    return Boolean(host) && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function proxy(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");
  const isWrite = isApi && !SAFE_METHODS.has(req.method);

  if (isWrite) {
    if (!sameOrigin(req)) return refuse(403, "Cross-site request refused");
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return refuse(415, "Send JSON");
    }
  }

  if (BOOTSTRAP.has(pathname)) return NextResponse.next();
  let ready: boolean;
  try {
    ready = setupComplete();
  } catch (e) {
    if (!isDbBlocked(e)) throw e;
    // The database must not be used (lib/db.ts DbBlockedError). Pages render
    // the explanation screen (app/layout.tsx); API calls get a 503 with the
    // same code /api/health reports. Nothing reaches the data.
    if (!isApi) return NextResponse.next();
    return NextResponse.json({ error: "The hub can't use its data right now", code: e.code }, { status: 503 });
  }
  if (!ready) return NextResponse.next();

  const parent = verifyCookie(req.cookies.get(PARENT_COOKIE)?.value, "parent");
  const device = parent || !readsLocked() || verifyCookie(req.cookies.get(DEVICE_COOKIE)?.value, "device");

  if (!device && !PUBLIC_PAGES.has(pathname)) {
    if (isApi) return refuse(401, "Unlock this screen with the parent PIN");
    const url = req.nextUrl.clone();
    url.pathname = "/unlock";
    url.search = `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }

  if (isWrite && !KID_WRITES.has(pathname) && !parent) return refuse(403, "Parent PIN required");
  return NextResponse.next();
}

export const config = {
  // Everything except build assets and files from public/.
  matcher: ["/((?!_next/static|favicon\\.ico|demo-avatars/).*)"],
};
