import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A module that is switched off contacts nothing outside the hub, even from a
// core route (parent settings) or a parent's read that the proxy lets through.

vi.mock("@/lib/ics", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/ics")>();
  // No real feed download in tests; the call itself is what is checked.
  return { ...real, refreshIcsNow: vi.fn(async () => {}) };
});
vi.mock("@/lib/household-settings", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/household-settings")>();
  return { ...real, checkCalendarLink: vi.fn(async (url: string) => ({ ok: true as const, value: url })) };
});

import { GET as bookSearch } from "@/app/api/books/search/route";
import { POST as parentPost } from "@/app/api/settings/parent/route";
import { hashPin } from "@/lib/auth";
import { checkCalendarLink } from "@/lib/household-settings";
import { refreshIcsNow } from "@/lib/ics";
import { setEnabled } from "@/lib/modules";
import { getSetting, setSetting } from "@/lib/queries";
import { PARENT_COOKIE, signCookie } from "@/lib/session";
import { TOGGLEABLE_MODULES } from "@/modules/registry";

const HOST = "hub.home:3847";
const LINK = "https://calendar.example.com/private-sample/basic.ics";
const ALL_ON = Object.fromEntries(TOGGLEABLE_MODULES.map((m) => [m.id, true]));

function saveLink(url: string) {
  return parentPost(
    new NextRequest(`http://${HOST}/api/settings/parent`, {
      method: "POST",
      headers: {
        host: HOST,
        origin: `http://${HOST}`,
        "content-type": "application/json",
        cookie: `${PARENT_COOKIE}=${signCookie("parent")}`,
      },
      body: JSON.stringify({ section: "calendar", owner: "kids_shared", url }),
    })
  );
}

const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ docs: [] }));

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.mocked(refreshIcsNow).mockClear();
  vi.mocked(checkCalendarLink).mockClear();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  const h = hashPin("5938");
  setSetting("parent_pin", `${h.salt}:${h.hash}`);
  setSetting("ics_url_kids_shared", "");
  setEnabled(ALL_ON, { actor: "parent" });
});

describe("saving a calendar link in parent settings", () => {
  it("with Calendar off: the link is saved, and no feed is checked or refreshed", async () => {
    setEnabled({ calendar: false }, { actor: "parent" });
    const res = await saveLink(LINK);
    expect(res.status).toBe(200);
    expect(getSetting("ics_url_kids_shared")).toBe(LINK);
    expect(checkCalendarLink).not.toHaveBeenCalled();
    expect(refreshIcsNow).not.toHaveBeenCalled();
    // A bad address is still refused without contacting anything.
    expect((await saveLink("not a link")).status).toBe(400);
    expect(checkCalendarLink).not.toHaveBeenCalled();
  });

  it("with Calendar on: the link is checked, saved and refreshed as before", async () => {
    const res = await saveLink(LINK);
    expect(res.status).toBe(200);
    expect(getSetting("ics_url_kids_shared")).toBe(LINK);
    expect(checkCalendarLink).toHaveBeenCalledTimes(1);
    expect(refreshIcsNow).toHaveBeenCalledTimes(1);
  });
});

describe("book search", () => {
  const search = () => bookSearch(new NextRequest(`http://${HOST}/api/books/search?q=frog+and+toad`));

  it("with Reading off answers module_off and calls no book site", async () => {
    setEnabled({ reading: false }, { actor: "parent" });
    const res = await search();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "module_off" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("with Reading on searches as before", async () => {
    const res = await search();
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("openlibrary.org");
  });
});
