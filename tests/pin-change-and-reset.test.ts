import { execFileSync } from "node:child_process";
import path from "node:path";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";

import { POST as pinPost } from "@/app/api/pin/route";
import { hashPin } from "@/lib/auth";
import { _resetPinAttemptsForTests, clearPinLocks } from "@/lib/pin-attempts";
import { getSetting, pinMatches as checkPin, setSetting } from "@/lib/queries";
import { PARENT_COOKIE, signCookie, verifyCookie } from "@/lib/session";

const OLD = "5938";

function post(body: unknown) {
  return pinPost(
    new NextRequest("http://hub.home/api/pin", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://hub.home", host: "hub.home" },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  const h = hashPin(OLD);
  setSetting("parent_pin", `${h.salt}:${h.hash}`);
  clearPinLocks();
  _resetPinAttemptsForTests();
});

describe("PIN change", () => {
  it("needs the current PIN, rejects weak PINs, and logs out old screens", async () => {
    const oldCookie = signCookie("parent");
    expect((await post({ action: "change", pin: "8642", newPin: "7319" })).status).toBe(403);
    expect((await post({ action: "change", pin: OLD, newPin: "1234" })).status).toBe(400);
    const ok = await post({ action: "change", pin: OLD, newPin: "7319" });
    expect(ok.status).toBe(200);
    expect(verifyCookie(oldCookie, "parent")).toBe(false);
    expect(verifyCookie(ok.cookies.get(PARENT_COOKIE)?.value, "parent")).toBe(true);
    expect(checkPin("7319")).toBe(true);
    expect(checkPin(OLD)).toBe(false);
  });
});

describe("reset-pin script (host-only recovery)", () => {
  const script = path.resolve(__dirname, "../scripts/reset-pin.mjs");
  const run = (pin: string) =>
    execFileSync(process.execPath, [script, pin], { env: { ...process.env }, encoding: "utf8", stdio: "pipe" });

  it("refuses weak PINs", () => {
    for (const weak of ["1234", "0000", "12", "abcd", "9876"]) {
      expect(() => run(weak)).toThrow();
    }
  });

  it("sets a new PIN, clears the lockout and revokes every cookie", () => {
    const before = signCookie("parent");
    setSetting("pin_new_locked_until", String(Date.now() + 600_000));
    setSetting("pin_screen_locked_until", String(Date.now() + 600_000));
    expect(run("4827")).toContain("Parent PIN reset");
    expect(verifyCookie(before, "parent")).toBe(false);
    expect(checkPin("4827")).toBe(true);
    expect(getSetting("pin_new_locked_until")).toBe("");
    expect(getSetting("pin_screen_locked_until")).toBe("");
  });
});
