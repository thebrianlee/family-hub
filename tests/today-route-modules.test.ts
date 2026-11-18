import { beforeEach, describe, expect, it, vi } from "vitest";

// /api/today and /api/ambient with modules off (spec §3.4.3, AC 1, 3, 8).
// This file runs on an upgraded household: the da1ecc2 fixture, set up, so
// migration 0002 turns every module on, Ask included.

await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { default: Database } = await import("better-sqlite3");
  const file = path.join(process.env.DATA_DIR!, "upgraded.db");
  fs.copyFileSync(path.resolve(__dirname, "fixtures/db-da1ecc2.db"), file);
  const raw = new Database(file);
  raw.prepare("UPDATE settings SET value='1' WHERE key='setup_complete'").run();
  raw.close();
  process.env.SPROUTWALL_DB = file;
});

vi.mock("@/lib/spark", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/spark")>();
  return { ...real, refreshSparkIfStale: vi.fn(real.refreshSparkIfStale) };
});
vi.mock("@/lib/ics", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/ics")>();
  return { ...real, refreshIcsIfStale: vi.fn(real.refreshIcsIfStale) };
});

import { GET as ambientGet } from "@/app/api/ambient/route";
import { GET as todayGet } from "@/app/api/today/route";
import { refreshIcsIfStale } from "@/lib/ics";
import { setEnabled } from "@/lib/modules";
import { getDb } from "@/lib/db";
import { setSetting } from "@/lib/queries";
import { refreshSparkIfStale } from "@/lib/spark";
import { TOGGLEABLE_MODULES } from "@/modules/registry";

const ALL = (on: boolean) => Object.fromEntries(TOGGLEABLE_MODULES.map((m) => [m.id, on]));
// The keys /api/today returned before modules existed.
const PREVIOUS_KEYS = ["balances", "currency", "dinner", "events", "greeting", "kids", "meals", "rhythm", "rules", "spark", "statuses", "weather"];
const CORE_KEYS = ["currency", "greeting", "kids", "rules", "statuses", "tabs", "weather"];

const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 500 }));
const bridgeCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("127.0.0.1"));

async function today() {
  return (await todayGet()).json() as Promise<Record<string, unknown> & { kids: Record<string, unknown>[]; tabs: { id: string; label: string }[] }>;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.mocked(refreshIcsIfStale).mockClear();
  vi.mocked(refreshSparkIfStale).mockClear();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  process.env.BRIDGE_TOKEN = "test-bridge-token-0123456789";
  // Fresh cached weather, so the only outbound call left to see is the bridge.
  setSetting("weather_cache", JSON.stringify({ temp: 60, hi: 64, lo: 50, emoji: "☀️", label: "Sunny" }));
  setSetting("weather_fetched_at", new Date().toISOString());
  getDb().prepare("DELETE FROM spark_cache").run();
});

describe("/api/today with modules", () => {
  it("an upgraded household has every module on: the previous keys plus tabs (AC 3)", async () => {
    const t = await today();
    expect(Object.keys(t).sort()).toEqual([...PREVIOUS_KEYS, "tabs"].sort());
    expect(t.tabs.map((x) => x.label)).toEqual(["Today", "Calendar", "Routines", "Meals", "Lists", "Ask"]);
    expect(Object.keys(t.kids[0]).sort()).toEqual(["done", "earnedToday", "kid", "mood", "total"]);
    expect(refreshIcsIfStale).toHaveBeenCalledTimes(1);
    expect(refreshSparkIfStale).toHaveBeenCalledTimes(1);
    // The control for AC 1: with Ask on, the spark refresh does call the bridge.
    expect(bridgeCalls().length).toBe(1);
  });

  it("with every module off: only core fields, no refresh, no outbound call", async () => {
    setEnabled(ALL(false), { actor: "parent" });
    const t = await today();
    expect(Object.keys(t).sort()).toEqual(CORE_KEYS);
    expect(t.tabs).toEqual([{ id: "core", href: "/today", label: "Today" }]);
    expect(t.kids.length).toBe(3);
    for (const k of t.kids) expect(Object.keys(k).sort()).toEqual(["kid", "mood"]);
    expect(refreshIcsIfStale).not.toHaveBeenCalled();
    expect(refreshSparkIfStale).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    setEnabled(ALL(true), { actor: "parent" });
  });

  it("routines on, rewards off: rings stay, points go", async () => {
    setEnabled({ ...ALL(true), rewards: false }, { actor: "parent" });
    const t = await today();
    expect(t).not.toHaveProperty("balances");
    expect(t).toHaveProperty("rhythm");
    expect(Object.keys(t.kids[0]).sort()).toEqual(["done", "kid", "mood", "total"]);
    setEnabled(ALL(true), { actor: "parent" });
  });

  it("each module leaves out its own fields and tab", async () => {
    const owned: Record<string, string[]> = {
      calendar: ["events"],
      routines: ["rhythm", "balances"], // rewards depends on routines
      rewards: ["balances"],
      meals: ["dinner", "meals"],
      ask: ["spark"],
    };
    for (const [id, keys] of Object.entries(owned)) {
      setEnabled({ ...ALL(true), [id]: false }, { actor: "parent" });
      const t = await today();
      for (const key of keys) expect(t, `${id} off`).not.toHaveProperty(key);
      expect(t.tabs.map((x) => x.id)).not.toContain(id);
      setEnabled(ALL(true), { actor: "parent" });
    }
    setEnabled({ ...ALL(true), calendar: false }, { actor: "parent" });
    vi.mocked(refreshIcsIfStale).mockClear();
    await today();
    expect(refreshIcsIfStale).not.toHaveBeenCalled();
    setEnabled(ALL(true), { actor: "parent" });
  });
});

describe("Ask off makes no bridge calls (AC 1, AC 8)", () => {
  it("neither Today nor the screensaver calls the bridge, and the screensaver keeps only the rules", async () => {
    setEnabled({ ...ALL(true), ask: false }, { actor: "parent" });
    await today();
    const ambient = (await (await ambientGet()).json()) as { quotes: { kind: string }[] };
    expect(refreshSparkIfStale).not.toHaveBeenCalled();
    expect(bridgeCalls()).toEqual([]);
    expect(ambient.quotes.length).toBeGreaterThan(0);
    expect(ambient.quotes.every((q) => q.kind === "rule")).toBe(true);

    setEnabled(ALL(true), { actor: "parent" });
    const withAsk = (await (await ambientGet()).json()) as { quotes: { kind: string }[] };
    expect(withAsk.quotes.some((q) => q.kind === "quote")).toBe(true);
  });
});
