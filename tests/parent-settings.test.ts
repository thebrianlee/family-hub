import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";

import { GET, POST } from "@/app/api/settings/parent/route";
import { hashPin } from "@/lib/auth";
import { checkCalendarLink, parseCalendarLink as normalizeCalendarUrl } from "@/lib/household-settings";
import { getSetting, setSetting } from "@/lib/queries";
import { PARENT_COOKIE, signCookie } from "@/lib/session";

const ORIGIN = "http://hub.home";

function req(method: "GET" | "POST", body?: unknown, parent = true) {
  const headers: Record<string, string> = { host: "hub.home", origin: ORIGIN, "content-type": "application/json" };
  if (parent) headers.cookie = `${PARENT_COOKIE}=${signCookie("parent")}`;
  return new NextRequest(`${ORIGIN}/api/settings/parent`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const household = {
  section: "household",
  familyName: "The Parks",
  greeting: "Hi Parks",
  currency: "Stars",
  timezone: "America/New_York",
  latitude: "40.7",
  longitude: "-74",
};

beforeEach(() => {
  const h = hashPin("5938");
  setSetting("parent_pin", `${h.salt}:${h.hash}`);
  setSetting("ics_url_kids_shared", "");
});

describe("parent settings API", () => {
  it("is parent-only for reading and writing", async () => {
    expect((await GET(req("GET", undefined, false))).status).toBe(403);
    expect((await POST(req("POST", household, false))).status).toBe(403);
    expect((await GET(req("GET"))).status).toBe(200);
  });

  it("validates and saves the household, and drops the cached forecast", async () => {
    setSetting("weather_cache", "{\"old\":true}");
    expect((await POST(req("POST", { ...household, timezone: "Mars/Olympus" }))).status).toBe(400);
    expect((await POST(req("POST", { ...household, latitude: "95" }))).status).toBe(400);
    expect((await POST(req("POST", { ...household, latitude: "" }))).status).toBe(400);
    const ok = await POST(req("POST", household));
    expect(ok.status).toBe(200);
    expect(getSetting("family_name")).toBe("The Parks");
    expect(getSetting("timezone")).toBe("America/New_York");
    expect(getSetting("weather_lat")).toBe("40.7");
    expect(getSetting("weather_cache")).toBe("");
  });

  it("never returns a stored calendar address, only its host", async () => {
    setSetting("ics_url_kids_shared", "https://calendar.example.com/private-abc123/basic.ics");
    const data = await (await GET(req("GET"))).json();
    const shared = data.calendars.find((c: { id: string }) => c.id === "kids_shared");
    expect(shared).toMatchObject({ linked: true, host: "calendar.example.com" });
    expect(JSON.stringify(data)).not.toContain("private-abc123");
  });

  it("refuses unknown owners and private-network calendar links, and can remove a link", async () => {
    expect((await POST(req("POST", { section: "calendar", owner: "nobody", url: "https://x.example/a.ics" }))).status).toBe(400);
    const priv = await POST(req("POST", { section: "calendar", owner: "kids_shared", url: "http://127.0.0.1:3847/api/health" }));
    expect(priv.status).toBe(400);
    expect(getSetting("ics_url_kids_shared")).toBe("");
    setSetting("ics_url_kids_shared", "https://calendar.example.com/x.ics");
    expect((await POST(req("POST", { section: "calendar", owner: "kids_shared", url: "" }))).status).toBe(200);
    expect(getSetting("ics_url_kids_shared")).toBe("");
  });

  it("toggles the Ask the Hub first-name setting", async () => {
    expect((await POST(req("POST", { section: "privacy", askShareFirstName: "yes" }))).status).toBe(400);
    await POST(req("POST", { section: "privacy", askShareFirstName: true }));
    expect(getSetting("ask_share_first_name")).toBe("1");
    await POST(req("POST", { section: "privacy", askShareFirstName: false }));
    expect(getSetting("ask_share_first_name")).toBe("0");
  });
});

describe("calendar link normalization", () => {
  it("accepts webcal and https, refuses everything else", () => {
    expect(normalizeCalendarUrl("webcal://p01-caldav.example.com/published/2/abc")).toEqual({
      ok: true,
      value: "https://p01-caldav.example.com/published/2/abc",
    });
    expect(normalizeCalendarUrl("  https://calendar.example.com/a.ics ")).toMatchObject({ ok: true });
    for (const bad of ["", "ftp://x.example/a.ics", "javascript:alert(1)", "https://user:pw@x.example/a.ics", "not a url", 42]) {
      expect(normalizeCalendarUrl(bad).ok).toBe(false);
    }
  });
});

describe("family members in settings", () => {
  it("adds, edits and hides members, but never the last kid or parent", async () => {
    const add = await POST(req("POST", { section: "member-add", role: "kid", name: "Mina", age: "7", color: "#C2738A" }));
    expect(add.status).toBe(200);
    const mina = (await add.json()).members.find((m: { name: string }) => m.name === "Mina");
    expect(mina).toMatchObject({ role: "kid", age: 7, color: "#C2738A" });

    const bad = await POST(req("POST", { section: "member-update", id: mina.id, name: "Mina", age: "40", color: "#C2738A" }));
    expect(bad.status).toBe(400);
    const renamed = await POST(req("POST", { section: "member-update", id: mina.id, name: "Mina K", age: "8", color: "#4E978F" }));
    expect((await renamed.json()).members.find((m: { id: string }) => m.id === mina.id)).toMatchObject({ name: "Mina K", age: 8 });

    expect((await POST(req("POST", { section: "member-update", id: "nobody", name: "X", age: "3", color: "#C2738A" }))).status).toBe(400);
    expect((await POST(req("POST", { section: "member-add", role: "admin", name: "Eve", color: "#C2738A" }))).status).toBe(400);

    const hidden = await POST(req("POST", { section: "member-remove", id: mina.id }));
    expect((await hidden.json()).members.some((m: { id: string }) => m.id === mina.id)).toBe(false);
  });

  it("starts over with a new family only when confirmed", async () => {
    const household = {
      kids: [{ name: "Ari", age: "6", color: "#6E9BBD" }],
      parents: [{ name: "Jo", color: "#5E7B86" }],
    };
    expect((await POST(req("POST", { section: "household-replace", household }))).status).toBe(400);
    // A parent session alone is not enough: the PIN itself is required.
    expect((await POST(req("POST", { section: "household-replace", confirm: "replace", household }))).status).toBe(403);
    expect((await POST(req("POST", { section: "household-replace", confirm: "replace", household, pin: "0000" }))).status).toBe(403);
    setSetting("ics_url_kids_shared", "https://calendar.example.com/old-family.ics");
    const res = await POST(req("POST", { section: "household-replace", confirm: "replace", household, pin: "5938" }));
    expect(res.status).toBe(200);
    const members = (await res.json()).members as { id: string; role: string }[];
    expect(members.map((m) => m.role)).toEqual(["kid", "parent"]);
    expect(getSetting("ics_url_kids_shared")).toBe("");
    // Now there is exactly one kid and one parent left, and neither can be removed.
    for (const m of members) {
      expect((await POST(req("POST", { section: "member-remove", id: m.id }))).status).toBe(400);
    }
  });
});

describe("calendar link check (same path as the sync)", () => {
  const cal = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";
  const res = (status: number, body = "", location: string | null = null) => ({
    status,
    contentType: "text/calendar",
    location,
    body: Buffer.from(body),
  });

  it("follows an iCloud-style redirect to the calendar", async () => {
    const seen: string[] = [];
    const get = async (url: string) => {
      seen.push(url);
      return url.includes("p01-") ? res(301, "", "https://p42-caldav.example.com/published/2/abc") : res(200, cal);
    };
    expect(await checkCalendarLink("https://p01-caldav.example.com/published/2/abc", get)).toMatchObject({ ok: true });
    expect(seen).toHaveLength(2);
  });

  it("explains a web page, a refusal and a downgrade in words a parent can act on", async () => {
    expect(await checkCalendarLink("https://x.example/a", async () => res(200, "<html>Sign in</html>"))).toMatchObject({
      ok: false,
      error: expect.stringContaining("isn't a calendar feed"),
    });
    expect(await checkCalendarLink("https://x.example/a", async () => res(404))).toMatchObject({
      ok: false,
      error: expect.stringContaining("refused that link"),
    });
    expect(await checkCalendarLink("https://x.example/a", async () => res(302, "", "http://x.example/a"))).toMatchObject({
      ok: false,
      error: expect.stringContaining("won't follow"),
    });
  });
});

