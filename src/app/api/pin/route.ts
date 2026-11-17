import { NextRequest, NextResponse } from "next/server";

import { attemptPin, type PinAttempt } from "@/lib/pin-attempts";
import {
  DEVICE_COOKIE,
  DEVICE_TTL_S,
  PARENT_COOKIE,
  PARENT_TTL_S,
  cookieOptions,
  signCookie,
} from "@/lib/session";

export const dynamic = "force-dynamic";

// { pin } → { ok }. A correct PIN unlocks this screen for 30 days (device
// cookie) and parent actions for 15 minutes (parent cookie). The parent-PIN
// modal calls this right before every parent action.
// { action: "lock" } ends the parent session on this screen.
function refused(attempt: Exclude<PinAttempt, { ok: true }>, wrongMessage: string): NextResponse {
  if (attempt.locked) {
    const minutes = Math.max(1, Math.ceil((attempt.retryAfterS ?? 60) / 60));
    return NextResponse.json(
      { ok: false, error: `Too many wrong tries. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` },
      { status: 429, headers: { "Retry-After": String(attempt.retryAfterS ?? 60) } }
    );
  }
  return NextResponse.json({ ok: false, error: wrongMessage }, { status: 403 });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (body.action === "lock") {
    const res = NextResponse.json({ ok: true });
    res.cookies.set(PARENT_COOKIE, "", { ...cookieOptions(0), maxAge: 0 });
    return res;
  }
  const attempt = attemptPin(req, body.pin);
  if (!attempt.ok) return refused(attempt, "Wrong PIN.");
  const res = NextResponse.json({ ok: true });
  res.cookies.set(PARENT_COOKIE, signCookie("parent"), cookieOptions(PARENT_TTL_S));
  res.cookies.set(DEVICE_COOKIE, signCookie("device"), cookieOptions(DEVICE_TTL_S));
  return res;
}
