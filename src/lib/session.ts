import { createHmac, timingSafeEqual } from "node:crypto";

import { sessionSecret } from "./auth";
import { getDb } from "./db";

// Two signed cookies, with different powers:
//  - device (30 days): this screen may read the hub and do kid-level writes.
//    Only matters when REQUIRE_AUTH_FOR_READS=1.
//  - parent (15 minutes): parent-only actions. The screens ask for the PIN
//    before each parent action anyway; the short cookie limits what a kid can
//    do on a screen a parent just used.
// Both are issued by a correct PIN at /api/pin. Both carry the current "auth
// version" (derived from the stored PIN hash), so changing or resetting the
// PIN revokes every cookie at once.

export const DEVICE_COOKIE = "fh_device";
export const PARENT_COOKIE = "fh_parent";
export const DEVICE_TTL_S = 30 * 24 * 60 * 60;
export const PARENT_TTL_S = 15 * 60;

export type CookieKind = "device" | "parent";

/** Changes whenever the PIN is set, changed or reset. Empty before setup. */
export function authVersion(): string {
  const row = getDb().prepare("SELECT value FROM settings WHERE key='parent_pin'").get() as
    | { value: string }
    | undefined;
  const stored = row?.value ?? "";
  if (!stored) return "";
  return createHmac("sha256", sessionSecret()).update(`v1:${stored}`).digest("base64url").slice(0, 16);
}

function mac(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

export function signCookie(kind: CookieKind, now = Date.now()): string {
  const ttl = kind === "device" ? DEVICE_TTL_S : PARENT_TTL_S;
  const payload = Buffer.from(JSON.stringify({ k: kind, exp: now + ttl * 1000, v: authVersion() })).toString(
    "base64url"
  );
  return `${payload}.${mac(payload)}`;
}

export function verifyCookie(token: string | undefined | null, kind: CookieKind, now = Date.now()): boolean {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(mac(payload));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      k?: string;
      exp?: number;
      v?: string;
    };
    const version = authVersion();
    return parsed.k === kind && typeof parsed.exp === "number" && parsed.exp > now && Boolean(version) && parsed.v === version;
  } catch {
    return false;
  }
}

export function readsLocked(): boolean {
  return process.env.REQUIRE_AUTH_FOR_READS === "1";
}

/** Whether this screen may read the household: it holds a valid parent or
 *  device cookie, or reads are not locked. The proxy and the root layout both
 *  ask this, so a locked browser gets neither household API answers nor
 *  household data inside the page. */
export function screenUnlocked(cookie: (name: string) => string | undefined): boolean {
  if (verifyCookie(cookie(PARENT_COOKIE), "parent")) return true;
  if (!readsLocked()) return true;
  return verifyCookie(cookie(DEVICE_COOKIE), "device");
}

export function setupComplete(): boolean {
  const row = getDb().prepare("SELECT value FROM settings WHERE key='setup_complete'").get() as
    | { value: string }
    | undefined;
  return row?.value === "1";
}

/** Cookie attributes. Secure only when the hub is served over https. */
export function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    path: "/",
    secure: (process.env.PUBLIC_URL ?? "").startsWith("https://"),
    maxAge,
  };
}
