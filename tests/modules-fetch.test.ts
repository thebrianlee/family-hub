import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Every outside request a module makes goes through src/lib/module-fetch.ts,
// which reads the module's state at the moment the request would start. A
// module switched off in the middle of a refresh, a search fallback, a
// backfill or a redirect chain starts nothing new.

// The real safeGet would go to the network; if anything reaches it, the test sees it.
vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return { ...real, safeGet: vi.fn(async () => ({ status: 500, contentType: "", location: null, body: Buffer.from("") })) };
});

import { POST as askPost } from "@/app/api/ask/route";
import { backfillCovers, downloadCover, searchBooks } from "@/lib/books";
import { getDb } from "@/lib/db";
import { replaceHousehold, validateHousehold } from "@/lib/household";
import { checkCalendarLink } from "@/lib/household-settings";
import { fetchCalendarText, refreshIcs } from "@/lib/ics";
import { ModuleOffError, moduleFetch, moduleGet } from "@/lib/module-fetch";
import { isEnabled, setEnabled } from "@/lib/modules";
import { getSetting, setSetting } from "@/lib/queries";
import { safeGet, type SafeGetter, type SafeResponse } from "@/lib/safe-fetch";
import { refreshSparkIfStale } from "@/lib/spark";
import { TOGGLEABLE_MODULES } from "@/modules/registry";

const ALL_ON = Object.fromEntries(TOGGLEABLE_MODULES.map((m) => [m.id, true]));
const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ docs: [] }));
const getMock = vi.fn<SafeGetter>(async () => calendar());
const urls = (mock: { mock: { calls: unknown[][] } }) => mock.mock.calls.map((c) => String(c[0]));

function ics(title: string): string {
  const d = new Date(Date.now() + 2 * 86_400_000);
  const day = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    "BEGIN:VEVENT",
    `UID:${title.length}@test`,
    "DTSTAMP:20260101T000000Z",
    `DTSTART:${day}T150000Z`,
    `DTEND:${day}T160000Z`,
    `SUMMARY:${title}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}
function calendar(title = "Swim practice"): SafeResponse {
  return { status: 200, contentType: "text/calendar", location: null, body: Buffer.from(ics(title)) };
}
function redirect(to: string): SafeResponse {
  return { status: 302, contentType: "", location: to, body: Buffer.from("") };
}
function image(): SafeResponse {
  return { status: 200, contentType: "image/jpeg", location: null, body: Buffer.alloc(2000, 1) };
}
const off = (id: string) => setEnabled({ [id]: false }, { actor: "parent" });

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => Response.json({ docs: [] }));
  getMock.mockReset();
  getMock.mockImplementation(async () => calendar());
  vi.mocked(safeGet).mockClear();
  vi.stubGlobal("fetch", fetchMock);
  setEnabled({ ...ALL_ON, ask: true }, { actor: "parent" });
});

describe("the helper", () => {
  it("with the module off starts no fetch and rejects with ModuleOffError", async () => {
    off("reading");
    const err = await moduleFetch("reading", "https://openlibrary.org/search.json?q=owls").catch((e) => e);
    expect(err).toBeInstanceOf(ModuleOffError);
    expect(err.moduleId).toBe("reading");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("with the module off starts no safe-fetch GET, injected or the real one", async () => {
    off("calendar");
    const opts = { maxBytes: 1000, timeoutMs: 1000 };
    await expect(moduleGet("calendar", "https://cal.example/a.ics", opts, getMock)).rejects.toBeInstanceOf(ModuleOffError);
    await expect(moduleGet("calendar", "https://cal.example/a.ics", opts)).rejects.toBeInstanceOf(ModuleOffError);
    expect(getMock).not.toHaveBeenCalled();
    expect(safeGet).not.toHaveBeenCalled();
  });

  it("with the module on passes the request through unchanged", async () => {
    const init = { cache: "no-store" as const };
    await moduleFetch("reading", "https://openlibrary.org/search.json?q=owls", init);
    expect(fetchMock).toHaveBeenCalledWith("https://openlibrary.org/search.json?q=owls", init);
    const opts = { maxBytes: 1000, timeoutMs: 1000 };
    await moduleGet("calendar", "https://cal.example/a.ics", opts, getMock);
    expect(getMock).toHaveBeenCalledWith("https://cal.example/a.ics", opts);
  });
});

describe("calendar", () => {
  const ROBIN = "https://cal.example/robin-sample.ics";
  const SHARED = "https://cal.example/kids-sample.ics";

  beforeEach(() => {
    replaceHousehold(
      validateHousehold({
        kids: [{ name: "Juno", age: 8, color: "#C2738A" }],
        parents: [{ name: "Robin", color: "#5E7B86" }],
      })
    );
    setSetting("ics_url_robin", ROBIN);
    setSetting("ics_url_kids_shared", SHARED);
    setSetting("ics_last_refresh", "");
    getDb().prepare("DELETE FROM synced_events").run();
  });
  const rowCount = () => (getDb().prepare("SELECT COUNT(*) c FROM synced_events").get() as { c: number }).c;

  it("a refresh with Calendar on fetches the own feed and then the shared feed", async () => {
    await refreshIcs(getMock);
    expect(urls(getMock)).toEqual([ROBIN, SHARED]);
    expect(rowCount()).toBeGreaterThan(0);
  });

  it("Calendar switched off during the first feed: the shared feed never starts, and nothing is written", async () => {
    getMock.mockImplementationOnce(async () => {
      off("calendar"); // a parent switches Calendar off while this feed downloads
      return calendar();
    });
    await refreshIcs(getMock);
    expect(urls(getMock)).toEqual([ROBIN]);
    expect(rowCount()).toBe(0);
    // Not marked as refreshed: the first refresh after Calendar is back on runs at once.
    expect(getSetting("ics_last_refresh", "")).toBe("");
  });

  it("Calendar switched off during a redirect: the next hop never starts", async () => {
    getMock.mockImplementationOnce(async () => {
      off("calendar");
      return redirect("https://p02.cal.example/robin-sample.ics");
    });
    await expect(fetchCalendarText(ROBIN, getMock)).rejects.toBeInstanceOf(ModuleOffError);
    expect(urls(getMock)).toEqual([ROBIN]);
  });

  it("the link check in Settings stops the same way, and says so to its caller", async () => {
    getMock.mockImplementationOnce(async () => {
      off("calendar");
      return redirect("https://p02.cal.example/robin-sample.ics");
    });
    await expect(checkCalendarLink(ROBIN, getMock)).rejects.toBeInstanceOf(ModuleOffError);
    expect(urls(getMock)).toEqual([ROBIN]);
  });
});

describe("reading", () => {
  const COVER = "https://covers.openlibrary.org/b/id/8675309-L.jpg";

  it("Reading switched off while Open Library answers: the Google Books fallback never starts", async () => {
    fetchMock.mockImplementationOnce(async () => {
      off("reading");
      return new Response("busy", { status: 503 });
    });
    await expect(searchBooks("owl moon")).rejects.toBeInstanceOf(ModuleOffError);
    expect(urls(fetchMock)).toHaveLength(1);
    expect(urls(fetchMock)[0]).toContain("openlibrary.org");
  });

  it("with Reading on, a failed Open Library search still falls back to Google Books", async () => {
    fetchMock.mockImplementationOnce(async () => new Response("busy", { status: 503 }));
    fetchMock.mockImplementationOnce(async () => Response.json({ items: [] }));
    await expect(searchBooks("owl moon")).resolves.toEqual([]);
    expect(urls(fetchMock)[1]).toContain("www.googleapis.com");
  });

  it("Reading switched off during a cover redirect: the next hop never starts", async () => {
    getMock.mockImplementationOnce(async () => {
      off("reading");
      return redirect("https://ia800100.us.archive.org/view/sample-L.jpg");
    });
    await expect(downloadCover(COVER, getMock)).rejects.toBeInstanceOf(ModuleOffError);
    expect(urls(getMock)).toEqual([COVER]);
  });

  it("with Reading on, a cover redirect is still followed", async () => {
    getMock.mockImplementationOnce(async () => redirect("https://ia800100.us.archive.org/view/sample-L.jpg"));
    getMock.mockImplementationOnce(async () => image());
    await expect(downloadCover(COVER, getMock)).resolves.toHaveLength(2000);
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it("Reading switched off during a backfill: no cover download and no next book's search", async () => {
    const db = getDb();
    db.prepare("DELETE FROM books").run();
    const kid = (db.prepare("SELECT id FROM members WHERE role='kid' LIMIT 1").get() as { id: string }).id;
    for (const title of ["Owl Moon", "Frog and Toad", "The Snowy Day"]) {
      db.prepare("INSERT INTO books (kid, title) VALUES (?, ?)").run(kid, title);
    }
    fetchMock.mockImplementationOnce(async () => {
      off("reading"); // switched off while the first book's search is on its way
      return Response.json({ docs: [{ title: "Owl Moon", cover_i: 8675309 }] });
    });
    await backfillCovers();
    expect(urls(fetchMock)).toHaveLength(1);
    expect(safeGet).not.toHaveBeenCalled();
  });
});

describe("ask", () => {
  it("Ask switched off before the bridge call: the question is refused and the bridge is not called", async () => {
    off("ask");
    const res = await askPost(
      new NextRequest("http://localhost/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "Why do owls hoot?" }),
      })
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "module_off" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the Daily Spark refresh does not call the bridge while Ask is off", async () => {
    process.env.BRIDGE_TOKEN = "sample-bridge-token-0123456789";
    getDb().prepare("DELETE FROM spark_cache").run();
    off("ask");
    expect(isEnabled("ask")).toBe(false);
    refreshSparkIfStale();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock).not.toHaveBeenCalled();
    delete process.env.BRIDGE_TOKEN;
  });
});
