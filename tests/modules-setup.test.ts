import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/setup/route";
import { getDb } from "@/lib/db";
import { enabledTabs, isEnabled } from "@/lib/modules";

// First-run setup with the "What should your wall show?" answer (spec §3.4.1).
// Setup can only succeed once, so each test first puts the database back to
// "not set up, no module rows" (what a fresh install has).

const fail = vi.hoisted(() => ({ claim: false }));
vi.mock("@/lib/queries", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/queries")>();
  return {
    ...real,
    // Lets a test break the claim transaction at its very last write.
    setSetting(key: string, value: string) {
      if (fail.claim && key === "setup_complete") throw new Error("disk full");
      return real.setSetting(key, value);
    },
  };
});

function freshDb() {
  getDb().prepare("UPDATE settings SET value='0' WHERE key='setup_complete'").run();
  getDb().prepare("DELETE FROM module_state").run();
}

function setupRequest(pin: string, extra: Record<string, unknown> = {}): NextRequest {
  return new NextRequest("http://localhost/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pin,
      familyName: "The Calder family",
      greeting: "Calders",
      currency: "Stars",
      timezone: "America/Chicago",
      latitude: 39.1,
      longitude: -94.6,
      ...extra,
    }),
  });
}

const rows = () =>
  Object.fromEntries(
    (getDb().prepare("SELECT id, enabled FROM module_state").all() as { id: string; enabled: number }[]).map((r) => [
      r.id,
      r.enabled === 1,
    ])
  );
const setupDone = () =>
  (getDb().prepare("SELECT value FROM settings WHERE key='setup_complete'").get() as { value: string }).value === "1";

const DEFAULTS = {
  calendar: true,
  routines: true,
  rewards: true,
  progress: true,
  reading: true,
  meals: true,
  lists: true,
  ask: false,
};

beforeEach(() => {
  fail.claim = false;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("setup with modules", () => {
  it("writes the chosen modules, and the tab bar follows (AC 2)", async () => {
    freshDb();
    const res = await POST(setupRequest("2468", { modules: { meals: false, lists: false } }));
    expect(res.status).toBe(200);
    expect(rows()).toEqual({ ...DEFAULTS, meals: false, lists: false });
    expect(enabledTabs().map((t) => t.label)).toEqual(["Today", "Calendar", "Routines"]);
    expect(isEnabled("meals")).toBe(false);
  });

  it("an old client that sends no modules gets the defaults, Ask off (AC 1)", async () => {
    freshDb();
    expect((await POST(setupRequest("2468"))).status).toBe(200);
    expect(rows()).toEqual(DEFAULTS);
    expect(enabledTabs().map((t) => t.id)).not.toContain("ask");
  });

  it('"recommended" (the skip button) means the defaults too', async () => {
    freshDb();
    expect((await POST(setupRequest("2468", { modules: "recommended" }))).status).toBe(200);
    expect(rows()).toEqual(DEFAULTS);
  });

  it("applies dependsOn and ignores core", async () => {
    freshDb();
    const res = await POST(setupRequest("2468", { modules: { routines: false, ask: true, core: false } }));
    expect(res.status).toBe(200);
    expect(rows()).toEqual({ ...DEFAULTS, routines: false, rewards: false, progress: false, ask: true });
    expect(isEnabled("core")).toBe(true);
  });

  it("refuses unknown ids and non-boolean values with a 400, and writes nothing", async () => {
    freshDb();
    const unknown = await POST(setupRequest("2468", { modules: { lists: false, chores: true } }));
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: "Unknown module: chores" });
    expect((await POST(setupRequest("2468", { modules: { lists: "no" } }))).status).toBe(400);
    expect((await POST(setupRequest("2468", { modules: ["lists"] }))).status).toBe(400);
    expect(rows()).toEqual({});
    expect(setupDone()).toBe(false);
  });

  it("writes the modules inside the claim transaction: a failed claim leaves no rows", async () => {
    freshDb();
    fail.claim = true;
    await expect(POST(setupRequest("2468", { modules: { lists: false } }))).rejects.toThrow("disk full");
    expect(rows()).toEqual({});
    expect(setupDone()).toBe(false);
    fail.claim = false;
    expect((await POST(setupRequest("2468", { modules: { lists: false } }))).status).toBe(200);
    expect(rows()).toEqual({ ...DEFAULTS, lists: false });
  });

  it("a setup that loses the race writes none of its modules", async () => {
    freshDb();
    // Both pass the up-front check before either body is read; only the
    // check inside the transaction can stop the second one.
    const [a, b] = await Promise.all([
      POST(setupRequest("2468", { modules: { lists: false } })),
      POST(setupRequest("9713", { modules: { meals: false } })),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? { lists: false } : { meals: false };
    expect(rows()).toEqual({ ...DEFAULTS, ...winner });
    // A later attempt is refused up front and changes nothing.
    expect((await POST(setupRequest("1357", { modules: { calendar: false } }))).status).toBe(409);
    expect(rows()).toEqual({ ...DEFAULTS, ...winner });
  });
});
