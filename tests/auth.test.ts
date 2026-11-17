import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";

import { POST as pinPost } from "@/app/api/pin/route";
import { POST as eventsPost } from "@/app/api/events/route";
import { hashPin } from "@/lib/auth";
import { setSetting } from "@/lib/queries";
import { DEVICE_COOKIE, PARENT_COOKIE, signCookie, verifyCookie } from "@/lib/session";
import { proxy } from "@/proxy";
import { _resetPinAttemptsForTests, clearPinLocks } from "@/lib/pin-attempts";

const HOST = "hub.home:3847";
const PIN = "5938";

function setPin(pin: string) {
  const h = hashPin(pin);
  setSetting("parent_pin", `${h.salt}:${h.hash}`);
  clearPinLocks();
  _resetPinAttemptsForTests();
}

function req(path: string, init: { method?: string; body?: unknown; cookies?: Record<string, string>; origin?: string | null; type?: string } = {}) {
  const headers = new Headers({ host: HOST });
  if (init.origin !== null) headers.set("origin", init.origin ?? `http://${HOST}`);
  if (init.body !== undefined) headers.set("content-type", init.type ?? "application/json");
  if (init.cookies) headers.set("cookie", Object.entries(init.cookies).map(([k, v]) => `${k}=${v}`).join("; "));
  return new NextRequest(`http://${HOST}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

beforeEach(() => {
  setSetting("setup_complete", "1");
  setPin(PIN);
  process.env.REQUIRE_AUTH_FOR_READS = "1";
});

describe("unlock cookies", () => {
  it("a correct PIN issues a device and a parent cookie; a wrong one issues nothing", async () => {
    const ok = await pinPost(req("/api/pin", { method: "POST", body: { pin: PIN } }));
    expect(ok.status).toBe(200);
    const device = ok.cookies.get(DEVICE_COOKIE);
    const parent = ok.cookies.get(PARENT_COOKIE);
    expect(verifyCookie(device?.value, "device")).toBe(true);
    expect(verifyCookie(parent?.value, "parent")).toBe(true);
    expect(device?.httpOnly).toBe(true);
    expect(device?.sameSite).toBe("strict");

    const bad = await pinPost(req("/api/pin", { method: "POST", body: { pin: "8642" } }));
    expect(bad.status).toBe(403);
    expect(bad.cookies.get(PARENT_COOKIE)).toBeUndefined();
  });

  it("cookies are not interchangeable, expire, and die when the PIN changes", () => {
    const device = signCookie("device");
    expect(verifyCookie(device, "parent")).toBe(false);
    expect(verifyCookie(signCookie("parent", Date.now() - 13 * 3600_000), "parent")).toBe(false);
    expect(verifyCookie(device + "x", "device")).toBe(false);
    setPin("7319");
    expect(verifyCookie(device, "device")).toBe(false);
  });
});

describe("proxy", () => {
  it("sends a locked screen to /unlock and refuses the API", () => {
    const page = proxy(req("/today"));
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toContain("/unlock?next=%2Ftoday");
    expect(proxy(req("/api/today")).status).toBe(401);
    expect(proxy(req("/api/photos/a.jpg")).status).toBe(401);
  });

  it("lets the unlock page, PIN submit and health through", () => {
    expect(proxy(req("/unlock")).status).toBe(200);
    expect(proxy(req("/api/health")).status).toBe(200);
    expect(proxy(req("/api/pin", { method: "POST", body: { pin: "0" } })).status).toBe(200);
  });

  it("an unlocked screen can read and do kid writes, but not parent writes", () => {
    const cookies = { [DEVICE_COOKIE]: signCookie("device") };
    expect(proxy(req("/api/today", { cookies })).status).toBe(200);
    expect(proxy(req("/api/myday", { method: "POST", body: {}, cookies })).status).toBe(200);
    expect(proxy(req("/api/settings", { method: "POST", body: {}, cookies })).status).toBe(403);
    expect(proxy(req("/api/events/refresh", { method: "POST", body: {}, cookies })).status).toBe(403);
    // A route nobody listed is parent-only by default.
    expect(proxy(req("/api/something-new", { method: "POST", body: {}, cookies })).status).toBe(403);
  });

  it("a parent cookie allows parent writes", () => {
    const cookies = { [PARENT_COOKIE]: signCookie("parent") };
    expect(proxy(req("/api/settings", { method: "POST", body: {}, cookies })).status).toBe(200);
  });

  it("refuses cross-site and Origin-less writes, and non-JSON bodies", () => {
    const cookies = { [PARENT_COOKIE]: signCookie("parent") };
    expect(proxy(req("/api/lists", { method: "POST", body: {}, cookies, origin: "http://evil.example" })).status).toBe(403);
    expect(proxy(req("/api/lists", { method: "POST", body: {}, cookies, origin: null })).status).toBe(403);
    expect(proxy(req("/api/lists", { method: "POST", body: {}, cookies, type: "text/plain" })).status).toBe(415);
  });

  it("with reads open, screens need no cookie but parent writes still do", () => {
    process.env.REQUIRE_AUTH_FOR_READS = "0";
    expect(proxy(req("/api/today")).status).toBe(200);
    expect(proxy(req("/api/lists", { method: "POST", body: {} })).status).toBe(200);
    expect(proxy(req("/api/rules", { method: "POST", body: {} })).status).toBe(403);
  });

  it("before setup, only the setup flow matters and nothing is locked", () => {
    setSetting("setup_complete", "0");
    expect(proxy(req("/today")).status).toBe(200);
  });
});

describe("route-level parent checks", () => {
  it("deleting an event needs a parent cookie or the PIN, even past the proxy", async () => {
    const denied = await eventsPost(req("/api/events", { method: "POST", body: { action: "delete", id: 1 } }));
    expect(denied.status).toBe(403);
    const withPin = await eventsPost(req("/api/events", { method: "POST", body: { action: "delete", id: 1, pin: PIN } }));
    expect(withPin.status).toBe(200);
    const withCookie = await eventsPost(
      req("/api/events", { method: "POST", body: { action: "delete", id: 1 }, cookies: { [PARENT_COOKIE]: signCookie("parent") } })
    );
    expect(withCookie.status).toBe(200);
  });
});
