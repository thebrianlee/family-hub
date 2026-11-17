import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";

import { hashPin } from "@/lib/auth";
import { CEILING_FAILS, CLIENT_FREE_TRIES, DAILY_CEILING_FAILS, _resetPinAttemptsForTests, attemptPin, clearPinLocks } from "@/lib/pin-attempts";
import { getSetting, setSetting } from "@/lib/queries";
import { DEVICE_COOKIE, signCookie } from "@/lib/session";

const PIN = "5938";

function req(ip: string, cookie?: string) {
  const headers: Record<string, string> = { "x-forwarded-for": ip };
  if (cookie) headers.cookie = cookie;
  return new NextRequest("http://hub.home/api/pin", { method: "POST", headers });
}

beforeEach(() => {
  const h = hashPin(PIN);
  setSetting("parent_pin", `${h.salt}:${h.hash}`);
  clearPinLocks();
  _resetPinAttemptsForTests();
});

describe("per-client backoff", () => {
  it("gives 5 free tries, then makes only that client wait", () => {
    const t = 1_000_000;
    for (let i = 1; i < CLIENT_FREE_TRIES; i++) expect(attemptPin(req("10.0.0.9"), "1111", t)).toEqual({ ok: false, locked: false });
    const fifth = attemptPin(req("10.0.0.9"), "1111", t);
    expect(fifth).toMatchObject({ ok: false, locked: true, retryAfterS: 60 });
    // Even the right PIN waits on that client...
    expect(attemptPin(req("10.0.0.9"), PIN, t + 1000).ok).toBe(false);
    // ...but another screen is unaffected.
    expect(attemptPin(req("10.0.0.20"), PIN, t + 1000).ok).toBe(true);
    // After the wait the right PIN works and clears the count.
    expect(attemptPin(req("10.0.0.9"), PIN, t + 61_000).ok).toBe(true);
  });

  it("doubles the wait and caps it at 15 minutes", () => {
    let t = 5_000_000;
    const waits: number[] = [];
    for (let i = 0; i < CLIENT_FREE_TRIES + 6; i++) {
      const r = attemptPin(req("10.0.0.9"), "1111", t);
      if (!r.ok && r.locked && r.retryAfterS) {
        waits.push(r.retryAfterS);
        t += r.retryAfterS * 1000 + 1;
      }
    }
    expect(waits).toEqual([60, 120, 240, 480, 900, 900, 900]);
  });

  it("counts the last X-Forwarded-For entry (what Next or a proxy adds)", () => {
    const t = 9_000_000;
    for (let i = 0; i < CLIENT_FREE_TRIES; i++) attemptPin(req(`forged-${i}, 10.0.0.9`), "1111", t);
    expect(attemptPin(req("anything, 10.0.0.9"), PIN, t).ok).toBe(false);
  });
});

const SCREEN = () => `${DEVICE_COOKIE}=${signCookie("device")}`;

describe("hub-wide ceilings", () => {
  it("locks new screens after 30 wrong tries in an hour, whatever address they claim, but not unlocked screens", () => {
    const t = 20_000_000;
    for (let i = 0; i < CEILING_FAILS; i++) attemptPin(req(`forged-${i}`), "1111", t);
    expect(attemptPin(req("10.0.0.77"), PIN, t + 1000)).toMatchObject({ ok: false, locked: true });
    // The kitchen screen holds a device cookie: a stranger can't lock it out.
    expect(attemptPin(req("10.0.0.5", SCREEN()), PIN, t + 1000).ok).toBe(true);
    expect(attemptPin(req("10.0.0.77"), PIN, t + 15 * 60_000 + 1000).ok).toBe(true);
  });

  it("caps guessing from unlocked screens too: forging X-Forwarded-For doesn't help", () => {
    const t = 30_000_000;
    let locked = false;
    for (let i = 0; i < 200 && !locked; i++) {
      const r = attemptPin(req(`forged-${i}`, SCREEN()), "1111", t);
      locked = !r.ok && r.locked && (r.retryAfterS ?? 0) >= 15 * 60;
    }
    expect(locked).toBe(true);
    // The right PIN waits too, from any address, while the lock lasts.
    expect(attemptPin(req("10.0.0.5", SCREEN()), PIN, t + 60_000).ok).toBe(false);
    // New screens are a separate ceiling and are not affected.
    expect(attemptPin(req("10.0.0.99"), PIN, t + 60_000).ok).toBe(true);
  });

  it("locks 15 min on the first hourly ceiling, then until the day ends once 60 are spent", () => {
    const t = 40_000_000;
    let r: ReturnType<typeof attemptPin> = { ok: false, locked: false };
    for (let i = 0; i < CEILING_FAILS; i++) r = attemptPin(req(`a-${i}`), "1111", t);
    expect(r).toMatchObject({ ok: false, locked: true, retryAfterS: 15 * 60 });
    const t2 = t + 15 * 60_000 + 1;
    for (let i = 0; i < CEILING_FAILS; i++) r = attemptPin(req(`b-${i}`), "1111", t2);
    // 60 spent: locked until 24 h after the day's first wrong try.
    expect(r.ok).toBe(false);
    expect((r as { retryAfterS: number }).retryAfterS).toBe(Math.ceil((t + 24 * 60 * 60_000 - t2) / 1000));
  }, 60_000);

  it("doubles the lock on each repeat within a day, up to 24 hours", () => {
    // Hourly trips of 30 each spend the daily 60 after two trips, so walk the
    // ladder one trip per day window to see the doubling (trips count across
    // days while they keep coming within 24 h of the last lock).
    let t = 200_000_000;
    const locks: number[] = [];
    for (let trip = 0; trip < 8; trip++) {
      let r: ReturnType<typeof attemptPin> = { ok: false, locked: false };
      for (let i = 0; i < CEILING_FAILS; i++) r = attemptPin(req(`d-${trip}-${i}`), "1111", t);
      locks.push((r as { retryAfterS: number }).retryAfterS / 60);
      t += 24 * 60 * 60_000 + 1; // next day window; within 24 h of the last lock's end only while locks are short
    }
    expect(locks.slice(0, 2)).toEqual([15, 30]);
    expect(Math.max(...locks)).toBeLessThanOrEqual(24 * 60);
  }, 60_000);

  it("caps slow guessing too: 29 an hour still locks once the day reaches 60", () => {
    let t = 80_000_000;
    let tries = 0;
    let firstLockAt = -1;
    for (let hour = 0; hour < 48 && firstLockAt < 0; hour++) {
      for (let i = 0; i < 29; i++) {
        const r = attemptPin(req(`slow-${hour}-${i}`), "1111", t + i * 1000);
        tries++;
        if (!r.ok && r.locked && (r.retryAfterS ?? 0) >= 15 * 60) {
          firstLockAt = tries;
          break;
        }
      }
      t += 60 * 60_000;
    }
    expect(firstLockAt).toBe(DAILY_CEILING_FAILS);
  }, 60_000);

  it("compares at most 60 wrong PINs a day per kind, even across expiring locks", () => {
    const start = 120_000_000;
    // Try once a minute for 24 h. Every compared wrong PIN is counted in the
    // day counter; tries refused up front are not compared at all.
    for (let t = start; t < start + 24 * 60 * 60_000 - 60_000; t += 60_000) attemptPin(req(`x-${t}`), "1111", t);
    expect(Number(getSetting("pin_new_day_fails"))).toBe(DAILY_CEILING_FAILS);
    // The right PIN is refused too until the day window ends, then works.
    expect(attemptPin(req("10.0.0.5"), PIN, start + 24 * 60 * 60_000 - 1000).ok).toBe(false);
    expect(attemptPin(req("10.0.0.5"), PIN, start + 24 * 60 * 60_000 + 1000).ok).toBe(true);
  }, 120_000);

  it("keeps a no-cookie client's wrong tries away from an unlocked screen on the same address", () => {
    const t = 90_000_000;
    for (let i = 0; i < CLIENT_FREE_TRIES; i++) attemptPin(req("10.0.0.5"), "1111", t);
    expect(attemptPin(req("10.0.0.5"), PIN, t + 1000).ok).toBe(false);
    expect(attemptPin(req("10.0.0.5", SCREEN()), PIN, t + 1000).ok).toBe(true);
  });

  it("forgets wrong tries older than an hour", () => {
    const t = 60_000_000;
    for (let i = 0; i < CEILING_FAILS - 1; i++) attemptPin(req(`a-${i}`), "1111", t);
    attemptPin(req("b-1"), "1111", t + 61 * 60_000);
    expect(attemptPin(req("c-1"), PIN, t + 61 * 60_000 + 1).ok).toBe(true);
  });
});
