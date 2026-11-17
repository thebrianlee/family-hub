import type { NextRequest } from "next/server";

import { getDb } from "./db";
import { getSetting, pinMatches, setSetting } from "./queries";
import { DEVICE_COOKIE, PARENT_COOKIE, verifyCookie } from "./session";

// Wrong-PIN protection.
//
// 1. Per client: 5 free tries, then 1, 2, 4, 8 and at most 15 minutes per
//    wrong try. A right PIN clears it. The client is the last X-Forwarded-For
//    entry (Next.js fills it from the socket when absent; a reverse proxy
//    appends what it saw). A device can forge that header, so this layer only
//    slows honest mistakes; the ceilings below are what bound guessing.
//
// 2. Two hub-wide ceilings, one per kind of client:
//      "new"    - screens that are not unlocked (a stranger on the Wi-Fi)
//      "screen" - screens that already hold an unlock cookie (the kitchen
//                 screen, a kid's tablet)
//    Every wrong try counts toward its kind's ceilings, whatever header the
//    client sends: 30 wrong tries within an hour, or 60 within a day, lock PIN
//    entry for that kind of client. Hourly locks double (15 min, 30, 1 h,
//    2 h, ... at most 24 h) until a day passes without one. Once 60 wrong
//    tries are spent, no PIN is even compared for that kind until the day
//    window (24 h from its first wrong try) ends, so slow guessing (say 29
//    an hour) gets 60 comparisons a day and not one more.
//
//    A lock blocks typing the PIN, nothing else: kids keep ticking routines,
//    adding to lists and so on, because those need no PIN. A stranger tripping
//    the "new" ceiling can't lock the family's unlocked screens; someone on an
//    unlocked screen tripping the "screen" ceiling only delays parent actions.
//
//    Bound: at most 60 wrong tries a day for each kind, 120 in all, however
//    they are paced. A 4-digit PIN can still fall within weeks to months;
//    6 or more digits are much stronger.

export const CLIENT_FREE_TRIES = 5;
const CLIENT_BASE_LOCK_MS = 60_000;
const CLIENT_MAX_LOCK_MS = 15 * 60_000;
const CLIENT_FORGET_MS = 24 * 60 * 60_000;
export const CEILING_FAILS = 30;
export const DAILY_CEILING_FAILS = 60;
const CEILING_WINDOW_MS = 60 * 60_000;
const DAILY_WINDOW_MS = 24 * 60 * 60_000;
const CEILING_BASE_LOCK_MS = 15 * 60_000;
const CEILING_MAX_LOCK_MS = 24 * 60 * 60_000;
const CEILING_RESET_MS = 24 * 60 * 60_000;
const MAX_TRACKED_CLIENTS = 1000;

export type ClientKind = "new" | "screen";

type ClientEntry = { fails: number; lockedUntil: number; last: number };
const clients = new Map<string, ClientEntry>();

export type PinAttempt = { ok: true } | { ok: false; locked: boolean; retryAfterS?: number };

export function clientKey(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for") ?? "";
  const last = forwarded.split(",").map((s) => s.trim()).filter(Boolean).pop();
  return (last || "unknown").slice(0, 64);
}

export function clientKind(req: NextRequest): ClientKind {
  const unlocked =
    verifyCookie(req.cookies.get(DEVICE_COOKIE)?.value, "device") ||
    verifyCookie(req.cookies.get(PARENT_COOKIE)?.value, "parent");
  return unlocked ? "screen" : "new";
}

function clientEntry(key: string, now: number): ClientEntry {
  const existing = clients.get(key);
  if (existing && now - existing.last < CLIENT_FORGET_MS) {
    // Move to the end so the map evicts the least recently used client first.
    clients.delete(key);
    clients.set(key, existing);
    return existing;
  }
  clients.delete(key);
  const fresh = { fails: 0, lockedUntil: 0, last: now };
  clients.set(key, fresh);
  while (clients.size > MAX_TRACKED_CLIENTS) {
    const oldest = clients.keys().next().value;
    if (oldest === undefined) break;
    clients.delete(oldest);
  }
  return fresh;
}

const num = (key: string) => {
  const n = Number(getSetting(key, "0"));
  return Number.isFinite(n) ? n : 0;
};

function ceilingLockedUntil(kind: ClientKind): number {
  return num(`pin_${kind}_locked_until`);
}

/** When the day's budget of wrong tries is used up: the end of that day window, else 0. */
function dailyBudgetSpentUntil(kind: ClientKind, now: number): number {
  const dayStart = num(`pin_${kind}_day_start`);
  if (dayStart <= 0 || now - dayStart >= DAILY_WINDOW_MS) return 0;
  return num(`pin_${kind}_day_fails`) >= DAILY_CEILING_FAILS ? dayStart + DAILY_WINDOW_MS : 0;
}

function recordCeilingFailure(kind: ClientKind, now: number): void {
  getDb().transaction(() => {
    const windowStart = num(`pin_${kind}_window_start`);
    const inWindow = windowStart > 0 && now - windowStart < CEILING_WINDOW_MS;
    const fails = (inWindow ? num(`pin_${kind}_fails`) : 0) + 1;
    if (!inWindow) setSetting(`pin_${kind}_window_start`, String(now));
    const dayStart = num(`pin_${kind}_day_start`);
    const inDay = dayStart > 0 && now - dayStart < DAILY_WINDOW_MS;
    const dayFails = (inDay ? num(`pin_${kind}_day_fails`) : 0) + 1;
    if (!inDay) setSetting(`pin_${kind}_day_start`, String(now));
    setSetting(`pin_${kind}_day_fails`, String(dayFails));
    if (fails < CEILING_FAILS && dayFails < DAILY_CEILING_FAILS) {
      setSetting(`pin_${kind}_fails`, String(fails));
      return;
    }
    // Ceiling hit: lock, doubling the lock while hits keep coming within a day.
    const lastTrip = num(`pin_${kind}_last_trip`);
    const trips = (lastTrip > 0 && now - lastTrip < CEILING_RESET_MS ? num(`pin_${kind}_trips`) : 0) + 1;
    const lockMs = Math.min(CEILING_BASE_LOCK_MS * 2 ** (trips - 1), CEILING_MAX_LOCK_MS);
    setSetting(`pin_${kind}_locked_until`, String(now + lockMs));
    setSetting(`pin_${kind}_trips`, String(trips));
    setSetting(`pin_${kind}_last_trip`, String(now + lockMs));
    setSetting(`pin_${kind}_fails`, "0");
    setSetting(`pin_${kind}_window_start`, "0");
  })();
}

/** Check a PIN typed on this client, applying every lockout layer. */
export function attemptPin(req: NextRequest, pin: unknown, now = Date.now()): PinAttempt {
  if (typeof pin !== "string" || pin.length === 0 || pin.length > 64) {
    return { ok: false, locked: false };
  }
  const kind = clientKind(req);
  // Keyed by kind too: wrong tries from a client with no unlock cookie never
  // slow down an unlocked screen that happens to share its address or proxy.
  const entry = clientEntry(`${kind}|${clientKey(req)}`, now);
  entry.last = now;
  // Strict daily budget: once 60 wrong tries are spent, no PIN is compared
  // for that kind of client until the day window ends, so expiring hourly
  // locks can't add extra comparisons.
  const ceilingUntil = Math.max(ceilingLockedUntil(kind), dailyBudgetSpentUntil(kind, now));
  if (ceilingUntil > now) {
    return { ok: false, locked: true, retryAfterS: Math.ceil((ceilingUntil - now) / 1000) };
  }
  if (entry.lockedUntil > now) {
    return { ok: false, locked: true, retryAfterS: Math.ceil((entry.lockedUntil - now) / 1000) };
  }
  if (pinMatches(pin)) {
    entry.fails = 0;
    entry.lockedUntil = 0;
    return { ok: true };
  }
  entry.fails += 1;
  recordCeilingFailure(kind, now);
  const afterCeiling = Math.max(ceilingLockedUntil(kind), dailyBudgetSpentUntil(kind, now));
  if (afterCeiling > now) {
    return { ok: false, locked: true, retryAfterS: Math.ceil((afterCeiling - now) / 1000) };
  }
  if (entry.fails >= CLIENT_FREE_TRIES) {
    const step = entry.fails - CLIENT_FREE_TRIES;
    entry.lockedUntil = now + Math.min(CLIENT_BASE_LOCK_MS * 2 ** step, CLIENT_MAX_LOCK_MS);
    return { ok: false, locked: true, retryAfterS: Math.ceil((entry.lockedUntil - now) / 1000) };
  }
  return { ok: false, locked: false };
}

/** Every stored lockout setting (all are "pin_*" keys; the PIN itself is "parent_pin"). */
const LOCK_KEY_PATTERN = "pin\\_%";

/** Clear every lock (used after a PIN change or reset). */
export function clearPinLocks(): void {
  clients.clear();
  getDb().prepare("DELETE FROM settings WHERE key LIKE ? ESCAPE '\\'").run(LOCK_KEY_PATTERN);
}

/** Test hook. */
export function _resetPinAttemptsForTests(): void {
  clients.clear();
}
