import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { hashPin } from "@/lib/auth";
import { setEnabled } from "@/lib/modules";
import { _resetPinAttemptsForTests, clearPinLocks } from "@/lib/pin-attempts";
import { setSetting } from "@/lib/queries";
import { DEVICE_COOKIE, PARENT_COOKIE, signCookie } from "@/lib/session";
import { TOGGLEABLE_MODULES, moduleForPath } from "@/modules/registry";
import { proxy } from "@/proxy";

// The module gate in src/proxy.ts (spec §3.4.4): after the lock, before the
// kid-write allowlist, and only ever adding refusals.

const HOST = "hub.home:3847";
const ALL_ON = Object.fromEntries(TOGGLEABLE_MODULES.map((m) => [m.id, true]));

type Who = "none" | "device" | "parent";
function req(
  p: string,
  init: { method?: string; who?: Who; origin?: string; body?: unknown } = {}
): NextRequest {
  const headers = new Headers({ host: HOST, origin: init.origin ?? `http://${HOST}` });
  const method = init.method ?? "GET";
  if (method !== "GET") headers.set("content-type", "application/json");
  const who = init.who ?? "none";
  if (who === "device") headers.set("cookie", `${DEVICE_COOKIE}=${signCookie("device")}`);
  if (who === "parent") headers.set("cookie", `${PARENT_COOKIE}=${signCookie("parent")}`);
  return new NextRequest(`http://${HOST}${p}`, {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify(init.body ?? {}),
  });
}

const passed = (res: Response) => res.headers.get("x-middleware-next") === "1";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {}); // setEnabled logs each toggle
  setSetting("setup_complete", "1");
  const h = hashPin("5938");
  setSetting("parent_pin", `${h.salt}:${h.hash}`);
  clearPinLocks();
  _resetPinAttemptsForTests();
  process.env.REQUIRE_AUTH_FOR_READS = "1";
  setEnabled(ALL_ON, { actor: "parent" });
});

describe("module gate", () => {
  it("redirects a page of a module that is off to /today, for everyone", () => {
    setEnabled({ meals: false }, { actor: "parent" });
    for (const who of ["device", "parent"] as const) {
      const res = proxy(req("/meals?week=2", { who }));
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe(`http://${HOST}/today`);
    }
    expect(passed(proxy(req("/lists", { who: "device" })))).toBe(true);
  });

  it("answers a read of a module that is off with 404 for a screen, and lets a parent read", async () => {
    setEnabled({ lists: false }, { actor: "parent" });
    const device = proxy(req("/api/lists", { who: "device" }));
    expect(device.status).toBe(404);
    expect(await device.json()).toEqual({ error: "module_off" });
    expect(passed(proxy(req("/api/lists", { who: "parent" })))).toBe(true);
    // With reads open, a screen without any cookie is refused the same way.
    process.env.REQUIRE_AUTH_FOR_READS = "0";
    expect(proxy(req("/api/lists")).status).toBe(404);
  });

  it("refuses a write to a module that is off for everyone, before the kid allowlist", async () => {
    setEnabled({ meals: false }, { actor: "parent" });
    for (const who of ["device", "parent"] as const) {
      const res = proxy(req("/api/meals", { method: "POST", who, body: { action: "set" } }));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "module_off" });
    }
  });

  it("a locked screen still gets 401 or the unlock page first", () => {
    setEnabled({ lists: false, meals: false }, { actor: "parent" });
    expect(proxy(req("/api/lists")).status).toBe(401);
    expect(proxy(req("/api/meals", { method: "POST" })).status).toBe(401);
    const page = proxy(req("/meals"));
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toContain("/unlock?next=%2Fmeals");
  });

  it("a cross-site write is refused before the gate", () => {
    setEnabled({ lists: false }, { actor: "parent" });
    const res = proxy(req("/api/lists", { method: "POST", who: "parent", origin: "http://evil.example" }));
    expect(res.status).toBe(403);
  });

  it("never gates core paths, and also matches an encoded path", () => {
    setEnabled({ routines: false, ask: false }, { actor: "parent" });
    expect(passed(proxy(req("/today", { who: "device" })))).toBe(true);
    expect(passed(proxy(req("/api/today", { who: "device" })))).toBe(true);
    expect(passed(proxy(req("/api/settings/modules", { who: "parent" })))).toBe(true);
    // The module watcher's route: never gated, but behind the read lock like any other.
    expect(passed(proxy(req("/api/modules", { who: "device" })))).toBe(true);
    expect(proxy(req("/api/modules")).status).toBe(401);
    // Routines off takes rewards and progress with it.
    expect(proxy(req("/api/balance", { who: "device" })).status).toBe(404);
    expect(proxy(req("/level-up", { who: "device" })).status).toBe(307);
    expect(proxy(req("/api/m%79day", { who: "device" })).status).toBe(404);
  });

  it("a double-encoded path to a module that is off reaches no route", async () => {
    setEnabled({ lists: false }, { actor: "parent" });
    const p = "/api/l%2569sts";
    // decodedPath() decodes once: "/api/l%69sts", which no module owns, so the
    // gate lets it through, and the router answers 404: there is no route at
    // either spelling, and only a second decode would give /api/lists.
    // Checked against a production build (next build, standalone server):
    // with lists off, /api/l%2569sts → the router's 404 not-found page, and
    // /api/lists and /api/l%69sts → the gate's 404 module_off. With lists on,
    // /api/l%69sts and /api/l%2569sts both get the router's 404 too.
    const once = decodeURIComponent(p);
    expect(once).toBe("/api/l%69sts");
    expect(moduleForPath(once)).toBeUndefined();
    expect(moduleForPath(decodeURIComponent(once))?.id).toBe("lists");
    const routes = appPaths();
    expect(routes).toContain("/api/lists");
    expect(routes).not.toContain(p);
    expect(routes).not.toContain(once);
    // What the proxy returns: the lock first, then a pass for reads, and the
    // kid-write allowlist still refuses a write.
    expect(proxy(req(p)).status).toBe(401);
    expect(passed(proxy(req(p, { who: "device" })))).toBe(true);
    expect(passed(proxy(req(p, { who: "parent" })))).toBe(true);
    const write = proxy(req(p, { method: "POST", who: "device", body: { action: "add" } }));
    expect(write.status).toBe(403);
    expect(await write.json()).toEqual({ error: "Parent PIN required" });
  });
});

/** Every page and API route under src/app, with a sample value for [params]. */
function appPaths(): string[] {
  const app = path.resolve(__dirname, "../src/app");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else if (e.name === "page.tsx" || e.name === "route.ts") {
        const rel = path.relative(app, dir).split(path.sep).filter(Boolean);
        out.push("/" + rel.map((s) => (s.startsWith("[") ? "sample.jpg" : s)).join("/"));
      }
    }
  };
  walk(app);
  return out;
}

describe("no access widening (AC 6)", () => {
  it("for every route, turning its module off never turns a 401 or 403 into a pass", () => {
    const paths = appPaths().filter((p) => !moduleForPath(p)?.core);
    expect(paths.length).toBeGreaterThan(20);
    let checked = 0;
    for (const p of paths) {
      const id = moduleForPath(p)!.id;
      const methods = p.startsWith("/api/") ? ["GET", "POST", "PUT", "DELETE"] : ["GET"];
      for (const locked of ["1", "0"]) {
        process.env.REQUIRE_AUTH_FOR_READS = locked;
        for (const method of methods) {
          for (const who of ["none", "device", "parent"] as const) {
            setEnabled(ALL_ON, { actor: "parent" });
            const on = proxy(req(p, { method, who }));
            setEnabled({ [id]: false }, { actor: "parent" });
            const off = proxy(req(p, { method, who }));
            const label = `${method} ${p} as ${who}, reads locked=${locked}`;
            // The lock comes first, so a 401 stays a 401. A 403 may become the
            // gate's 404 (writes are refused before the kid allowlist), but
            // never a pass.
            if (on.status === 401) expect(off.status, label).toBe(401);
            if (on.status === 401 || on.status === 403) {
              expect(passed(off), label).toBe(false);
              expect(off.status, label).toBeGreaterThanOrEqual(400);
            }
            if (on.status === 307) expect(off.headers.get("location"), label).toBe(on.headers.get("location"));
            // Off: a page goes to /unlock or /today; an API call only passes for a parent read.
            if (passed(off)) expect({ label, parentRead: who === "parent" && method === "GET" }).toEqual({ label, parentRead: true });
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(300);
  });
});
