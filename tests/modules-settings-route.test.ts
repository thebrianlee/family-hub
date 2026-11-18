import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET as listsGet, POST as listsPost } from "@/app/api/lists/route";
import { POST as mealsPost } from "@/app/api/meals/route";
import { GET, PUT } from "@/app/api/settings/modules/route";
import { hashPin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { setEnabled } from "@/lib/modules";
import { _resetPinAttemptsForTests, clearPinLocks } from "@/lib/pin-attempts";
import { setSetting } from "@/lib/queries";
import { DEVICE_COOKIE, PARENT_COOKIE, signCookie } from "@/lib/session";
import { TOGGLEABLE_MODULES } from "@/modules/registry";
import { proxy } from "@/proxy";

// Settings → Modules: GET/PUT /api/settings/modules (spec §3.4.2, AC 4, 5, 7).

const HOST = "hub.home:3847";
const PIN = "5938";

function req(
  path: string,
  init: { method?: string; body?: unknown; who?: "device" | "parent"; origin?: string } = {}
): NextRequest {
  const headers = new Headers({ host: HOST, origin: init.origin ?? `http://${HOST}` });
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.who === "device") headers.set("cookie", `${DEVICE_COOKIE}=${signCookie("device")}`);
  if (init.who === "parent") headers.set("cookie", `${PARENT_COOKIE}=${signCookie("parent")}`);
  return new NextRequest(`http://${HOST}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const put = (body: unknown, who?: "device" | "parent") => req("/api/settings/modules", { method: "PUT", body, who });
type Snapshot = { modules: { id: string; enabled: boolean; dependsOn: string[]; sendsChildDataTo: string[] }[] };
const states = (s: Snapshot) => Object.fromEntries(s.modules.map((m) => [m.id, m.enabled]));

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  setSetting("setup_complete", "1");
  const h = hashPin(PIN);
  setSetting("parent_pin", `${h.salt}:${h.hash}`);
  clearPinLocks();
  _resetPinAttemptsForTests();
  process.env.REQUIRE_AUTH_FOR_READS = "1";
  setEnabled(Object.fromEntries(TOGGLEABLE_MODULES.map((m) => [m.id, true])), { actor: "parent" });
});

describe("parent-only (AC 5)", () => {
  it("GET needs the parent cookie", async () => {
    expect((await GET(req("/api/settings/modules"))).status).toBe(403);
    expect((await GET(req("/api/settings/modules", { who: "device" }))).status).toBe(403);
    const ok = await GET(req("/api/settings/modules", { who: "parent" }));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as Snapshot;
    expect(body.modules.map((m) => m.id)).toEqual(TOGGLEABLE_MODULES.map((m) => m.id));
    expect(body.modules.find((m) => m.id === "ask")?.sendsChildDataTo.length).toBeGreaterThan(0);
  });

  it("PUT without a parent cookie or the PIN is refused, and changes nothing", async () => {
    const denied = await PUT(put({ modules: { lists: false } }));
    expect(denied.status).toBe(403);
    expect((await PUT(put({ modules: { lists: false }, pin: "8642" }))).status).toBe(403);
    expect((await PUT(put({ modules: { lists: false } }, "device"))).status).toBe(403);
    const after = await GET(req("/api/settings/modules", { who: "parent" }));
    expect(states(await after.json())).toMatchObject({ lists: true });
  });

  it("PUT works with the parent cookie; the PIN alone is not a way in, at the proxy or the route", async () => {
    // What a request really meets: the proxy first, then the route.
    const pinOnly = put({ modules: { lists: false }, pin: PIN }, "device");
    expect(proxy(pinOnly).status).toBe(403);
    expect((await PUT(put({ modules: { lists: false }, pin: PIN }, "device"))).status).toBe(403);
    const withCookie = put({ modules: { lists: false } }, "parent");
    expect(proxy(withCookie).headers.get("x-middleware-next")).toBe("1");
    const res = await PUT(put({ modules: { lists: false } }, "parent"));
    expect(res.status).toBe(200);
    expect(states(await res.json())).toMatchObject({ lists: false });
  });

  it("the proxy refuses a kid on an unlocked screen and a cross-site request", () => {
    expect(proxy(put({ modules: { ask: true } }, "device")).status).toBe(403);
    // With reads open, a screen with no cookie at all is refused too.
    process.env.REQUIRE_AUTH_FOR_READS = "0";
    expect(proxy(put({ modules: { ask: true } })).status).toBe(403);
    const crossSite = req("/api/settings/modules", { method: "PUT", body: { modules: {} }, who: "parent", origin: "http://evil.example" });
    expect(proxy(crossSite).status).toBe(403);
  });

  it("refuses unknown modules with a 400", async () => {
    const res = await PUT(put({ modules: { chores: true } }, "parent"));
    expect(res.status).toBe(400);
    expect((await PUT(put({}, "parent"))).status).toBe(400);
  });
});

describe("dependsOn (AC 7)", () => {
  it("turning off Routines turns off Rewards and Progress; turning on Rewards turns Routines back on", async () => {
    const off = states(await (await PUT(put({ modules: { routines: false } }, "parent"))).json());
    expect(off).toMatchObject({ routines: false, rewards: false, progress: false, reading: true });
    const on = states(await (await PUT(put({ modules: { rewards: true } }, "parent"))).json());
    expect(on).toMatchObject({ routines: true, rewards: true, progress: false });
  });
});

describe("data is kept (AC 4)", () => {
  function tableCounts(): Record<string, number> {
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[];
    return Object.fromEntries(
      tables.map(({ name }) => [name, (db.prepare(`SELECT COUNT(*) c FROM "${name}"`).get() as { c: number }).c])
    );
  }

  it("disabling and re-enabling Lists brings back the same rows and ids", async () => {
    await listsPost(req("/api/lists", { body: { action: "add_list", name: "Camping" } }));
    const lists = (await (await listsGet()).json()).lists as { id: number; name: string }[];
    const camping = lists.find((l) => l.name === "Camping")!;
    for (const label of ["Tent", "Lantern"]) {
      await listsPost(req("/api/lists", { body: { action: "add_item", listId: camping.id, label } }));
    }
    const items = () => getDb().prepare("SELECT * FROM list_items ORDER BY id").all();
    const before = { counts: tableCounts(), items: items(), lists: (await (await listsGet()).json()).lists };

    expect((await PUT(put({ modules: { lists: false } }, "parent"))).status).toBe(200);
    expect(proxy(req("/api/lists", { who: "device" })).status).toBe(404);
    expect(proxy(req("/lists", { who: "device" })).headers.get("location")).toBe(`http://${HOST}/today`);
    expect(tableCounts()).toEqual(before.counts);

    expect((await PUT(put({ modules: { lists: true } }, "parent"))).status).toBe(200);
    expect(proxy(req("/api/lists", { who: "device" })).headers.get("x-middleware-next")).toBe("1");
    expect(tableCounts()).toEqual(before.counts);
    expect(items()).toEqual(before.items);
    expect((await (await listsGet()).json()).lists).toEqual(before.lists);
  });
});

describe("cross-module writes", () => {
  it("Meals' Add to List is refused while Lists is off, and works again when it is on", async () => {
    const slot = { date: "2026-11-18", slot: "dinner" };
    await mealsPost(req("/api/meals", { body: { action: "set", ...slot, name: "Tacos", ingredients: ["Tortillas", "Limes"] } }));
    const items = () => (getDb().prepare("SELECT COUNT(*) c FROM list_items").get() as { c: number }).c;
    const before = items();
    await PUT(put({ modules: { lists: false } }, "parent"));
    const refused = await mealsPost(req("/api/meals", { body: { action: "addToList", ...slot } }));
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: "module_off" });
    expect(items()).toBe(before);
    await PUT(put({ modules: { lists: true } }, "parent"));
    const ok = await mealsPost(req("/api/meals", { body: { action: "addToList", ...slot } }));
    expect(ok.status).toBe(200);
    expect(items()).toBe(before + 2);
  });
});
