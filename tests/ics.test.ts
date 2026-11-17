import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@/lib/db";
import { fetchCalendarText, normalizeCalendarUrl, refreshIcs } from "@/lib/ics";
import { setSetting } from "@/lib/queries";
import type { SafeGetOptions, SafeResponse } from "@/lib/safe-fetch";

// ---------- helpers ----------

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** A small VCALENDAR with timed events tomorrow (inside the refresh window). */
function calendar(events: { uid: string; summary: string }[]): string {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 1);
  start.setUTCHours(15, 0, 0, 0);
  const end = new Date(start.getTime() + 3_600_000);
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Family Hub tests//EN"];
  for (const e of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.uid}`,
      `DTSTAMP:${stamp(new Date())}`,
      `DTSTART:${stamp(start)}`,
      `DTEND:${stamp(end)}`,
      `SUMMARY:${e.summary}`,
      "END:VEVENT"
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

const EXPIRED_PAGE = "<!doctype html><html><body><h1>This calendar link has expired</h1></body></html>";

function response(partial: Partial<SafeResponse>): SafeResponse {
  return { status: 200, contentType: "", location: null, body: Buffer.alloc(0), ...partial };
}

// ---------- local feed server ----------
// safeGet refuses loopback by design, so the refresh is handed a plain HTTP
// getter for this server. Production code always uses safeGet (the default).

type Route = { status: number; type?: string; body?: string; location?: string };
const routes = new Map<string, Route>();
let base = "";
let server: http.Server;

function plainGet(url: string, opts: SafeGetOptions): Promise<SafeResponse> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers: { Accept: opts.accept ?? "*/*" } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            contentType: String(res.headers["content-type"] ?? ""),
            location: typeof res.headers.location === "string" ? res.headers.location : null,
            body: Buffer.concat(chunks),
          })
        );
      })
      .on("error", reject);
  });
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const route = routes.get(req.url ?? "");
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    const headers: Record<string, string> = { "Content-Type": route.type ?? "text/calendar" };
    if (route.location) headers.Location = route.location;
    res.writeHead(route.status, headers).end(route.body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function rows(member: string): { id: string; title: string }[] {
  return getDb()
    .prepare("SELECT id, title FROM synced_events WHERE member=? ORDER BY id")
    .all(member) as { id: string; title: string }[];
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  routes.clear();
  const db = getDb();
  db.prepare("DELETE FROM synced_events").run();
  db.prepare("DELETE FROM settings WHERE key LIKE 'ics_url_%'").run();
});

// ---------- a failed or non-calendar fetch keeps the source's rows ----------

describe("refresh keeps a feed's rows when the fetch fails", () => {
  it("a 200 page that is not a calendar (expired link) keeps the member's events", async () => {
    setSetting("ics_url_avery", `${base}/avery.ics`);
    routes.set("/avery.ics", { status: 200, body: calendar([{ uid: "dentist@test", summary: "Dentist" }]) });
    await refreshIcs(plainGet);
    expect(rows("avery")).toEqual([{ id: "avery:dentist@test", title: "Dentist" }]);

    routes.set("/avery.ics", { status: 200, type: "text/html", body: EXPIRED_PAGE });
    await refreshIcs(plainGet);
    expect(rows("avery")).toEqual([{ id: "avery:dentist@test", title: "Dentist" }]);
  });

  it("an HTTP error keeps the member's events while another member still updates", async () => {
    setSetting("ics_url_avery", `${base}/avery.ics`);
    setSetting("ics_url_jordan", `${base}/jordan.ics`);
    routes.set("/avery.ics", { status: 200, body: calendar([{ uid: "a1@test", summary: "Standup" }]) });
    routes.set("/jordan.ics", { status: 200, body: calendar([{ uid: "j1@test", summary: "Yoga" }]) });
    await refreshIcs(plainGet);

    routes.set("/avery.ics", { status: 500, type: "text/plain", body: "oops" });
    routes.set("/jordan.ics", { status: 200, body: calendar([{ uid: "j2@test", summary: "Book Club" }]) });
    await refreshIcs(plainGet);
    expect(rows("avery")).toEqual([{ id: "avery:a1@test", title: "Standup" }]);
    expect(rows("jordan")).toEqual([{ id: "jordan:j2@test", title: "Book Club" }]);
  });

  it("a shared kids feed that turns into an HTML page keeps every kid's shared events", async () => {
    setSetting("ics_url_kids_shared", `${base}/kids.ics`);
    routes.set("/kids.ics", { status: 200, body: calendar([{ uid: "swim@test", summary: "Swim" }]) });
    await refreshIcs(plainGet);
    const before = ["riley", "quinn", "sam"].map(rows);
    expect(before[0]).toEqual([{ id: "shared:swim@test:riley", title: "Swim" }]);

    routes.set("/kids.ics", { status: 200, type: "text/html", body: EXPIRED_PAGE });
    await refreshIcs(plainGet);
    expect(["riley", "quinn", "sam"].map(rows)).toEqual(before);
  });

  it("a real calendar with no events does clear the member's events", async () => {
    setSetting("ics_url_avery", `${base}/avery.ics`);
    routes.set("/avery.ics", { status: 200, body: calendar([{ uid: "a1@test", summary: "Standup" }]) });
    await refreshIcs(plainGet);
    routes.set("/avery.ics", { status: 200, body: calendar([]) });
    await refreshIcs(plainGet);
    expect(rows("avery")).toEqual([]);
  });

  it("follows the feed server's redirect to the calendar", async () => {
    setSetting("ics_url_avery", `${base}/old-link`);
    routes.set("/old-link", { status: 302, location: "/avery.ics" });
    routes.set("/avery.ics", { status: 200, body: calendar([{ uid: "a1@test", summary: "Standup" }]) });
    await refreshIcs(plainGet);
    expect(rows("avery")).toEqual([{ id: "avery:a1@test", title: "Standup" }]);
  });
});

// ---------- rows stored before the source column ----------

describe("rows stored before the source column (source NULL)", () => {
  const insert = (id: string, member: string, title: string) =>
    getDb()
      .prepare("INSERT INTO synced_events (id, member, title, date) VALUES (?, ?, ?, date('now','localtime','+1 day'))")
      .run(id, member, title);

  it("go as soon as one of the member's feeds is refreshed, so a shared event never shows twice", async () => {
    // The oldest code stored a kid's shared events under the kid as
    // "<uid>:<kid>", next to the kid's own events ("<uid>"). Which feed an old
    // row came from is not recorded, so the first feed of that member that
    // refreshes replaces all of them; the failing feed's events come back on
    // its next successful fetch.
    insert("swim@test:riley", "riley", "Swim");
    insert("piano@test", "riley", "Piano");
    insert("swim@test:quinn", "quinn", "Swim");
    setSetting("ics_url_riley", `${base}/riley.ics`);
    setSetting("ics_url_kids_shared", `${base}/kids.ics`);
    routes.set("/riley.ics", { status: 503, type: "text/plain", body: "down" });
    routes.set("/kids.ics", { status: 200, body: calendar([{ uid: "swim@test", summary: "Swim" }]) });

    await refreshIcs(plainGet);
    const expected = {
      riley: [{ id: "shared:swim@test:riley", title: "Swim" }],
      quinn: [{ id: "shared:swim@test:quinn", title: "Swim" }],
      sam: [{ id: "shared:swim@test:sam", title: "Swim" }],
    };
    expect({ riley: rows("riley"), quinn: rows("quinn"), sam: rows("sam") }).toEqual(expected);

    // Running again changes nothing.
    await refreshIcs(plainGet);
    expect({ riley: rows("riley"), quinn: rows("quinn"), sam: rows("sam") }).toEqual(expected);
  });

  it("stay while the only feed that covers the member is failing", async () => {
    insert("swim@test:riley", "riley", "Swim");
    setSetting("ics_url_kids_shared", `${base}/kids.ics`);
    routes.set("/kids.ics", { status: 500, type: "text/plain", body: "down" });
    await refreshIcs(plainGet);
    expect(rows("riley")).toEqual([{ id: "swim@test:riley", title: "Swim" }]);
  });

  it("all go once that member's own feed succeeds", async () => {
    insert("standup@test", "avery", "Standup");
    setSetting("ics_url_avery", `${base}/avery.ics`);
    routes.set("/avery.ics", { status: 200, body: calendar([{ uid: "standup@test", summary: "Standup" }]) });
    await refreshIcs(plainGet);
    expect(rows("avery")).toEqual([{ id: "avery:standup@test", title: "Standup" }]);
  });

  it("are not duplicated when an own event's UID starts with \"shared:\"", async () => {
    // Stored by the oldest code as the bare UID, which looks like a shared-feed id.
    insert("shared:party@test", "avery", "Party");
    setSetting("ics_url_avery", `${base}/avery.ics`);
    routes.set("/avery.ics", { status: 200, body: calendar([{ uid: "shared:party@test", summary: "Party" }]) });
    await refreshIcs(plainGet);
    expect(rows("avery")).toEqual([{ id: "avery:shared:party@test", title: "Party" }]);
  });

  it("go when no link covers the member any more", async () => {
    insert("old@test", "jordan", "Old");
    await refreshIcs(plainGet);
    expect(rows("jordan")).toEqual([]);
  });
});

// ---------- removed links ----------

const sources = (member: string) =>
  (getDb().prepare("SELECT DISTINCT source FROM synced_events WHERE member=? ORDER BY source").all(member) as {
    source: string | null;
  }[]).map((r) => r.source);

describe("a calendar link that is removed", () => {
  it("takes the shared feed's rows with it on the next refresh, even when no link is left", async () => {
    setSetting("ics_url_kids_shared", `${base}/kids.ics`);
    routes.set("/kids.ics", { status: 200, body: calendar([{ uid: "swim@test", summary: "Swim" }]) });
    await refreshIcs(plainGet);
    expect(rows("riley")).toEqual([{ id: "shared:swim@test:riley", title: "Swim" }]);
    expect(sources("riley")).toEqual(["shared"]);

    setSetting("ics_url_kids_shared", "");
    await refreshIcs(plainGet);
    expect(["riley", "quinn", "sam"].map(rows)).toEqual([[], [], []]);
  });

  it("takes a member's own rows with it, while other feeds keep updating", async () => {
    setSetting("ics_url_avery", `${base}/avery.ics`);
    setSetting("ics_url_jordan", `${base}/jordan.ics`);
    routes.set("/avery.ics", { status: 200, body: calendar([{ uid: "a1@test", summary: "Standup" }]) });
    routes.set("/jordan.ics", { status: 200, body: calendar([{ uid: "j1@test", summary: "Yoga" }]) });
    await refreshIcs(plainGet);
    expect(sources("avery")).toEqual(["own"]);

    setSetting("ics_url_avery", "");
    routes.set("/jordan.ics", { status: 200, body: calendar([{ uid: "j2@test", summary: "Book Club" }]) });
    await refreshIcs(plainGet);
    expect(rows("avery")).toEqual([]);
    expect(rows("jordan")).toEqual([{ id: "jordan:j2@test", title: "Book Club" }]);
  });

  it("of a kid's own calendar leaves that kid's shared-feed rows alone", async () => {
    setSetting("ics_url_riley", `${base}/riley.ics`);
    setSetting("ics_url_kids_shared", `${base}/kids.ics`);
    routes.set("/riley.ics", { status: 200, body: calendar([{ uid: "piano@test", summary: "Piano" }]) });
    routes.set("/kids.ics", { status: 200, body: calendar([{ uid: "swim@test", summary: "Swim" }]) });
    await refreshIcs(plainGet);
    expect(rows("riley")).toEqual([
      { id: "riley:piano@test", title: "Piano" },
      { id: "shared:swim@test:riley", title: "Swim" },
    ]);

    setSetting("ics_url_riley", "");
    await refreshIcs(plainGet);
    expect(rows("riley")).toEqual([{ id: "shared:swim@test:riley", title: "Swim" }]);
  });

  it("is told apart from a link that fails: a failing link keeps its rows", async () => {
    setSetting("ics_url_avery", `${base}/avery.ics`);
    setSetting("ics_url_kids_shared", `${base}/kids.ics`);
    routes.set("/avery.ics", { status: 200, body: calendar([{ uid: "a1@test", summary: "Standup" }]) });
    routes.set("/kids.ics", { status: 200, body: calendar([{ uid: "swim@test", summary: "Swim" }]) });
    await refreshIcs(plainGet);

    routes.set("/avery.ics", { status: 500, type: "text/plain", body: "down" });
    routes.set("/kids.ics", { status: 200, type: "text/html", body: EXPIRED_PAGE });
    await refreshIcs(plainGet);
    expect(rows("avery")).toEqual([{ id: "avery:a1@test", title: "Standup" }]);
    expect(rows("sam")).toEqual([{ id: "shared:swim@test:sam", title: "Swim" }]);
  });
});

// ---------- webcal links and redirects ----------

describe("normalizeCalendarUrl", () => {
  it.each([
    ["webcal://p01-calendarws.icloud.com/published/2/abc", "https://p01-calendarws.icloud.com/published/2/abc"],
    ["webcals://example.com/cal.ics", "https://example.com/cal.ics"],
    ["WEBCAL://Example.com/cal.ics", "https://Example.com/cal.ics"],
    ["  webcal://example.com/cal.ics  ", "https://example.com/cal.ics"],
    ["https://calendar.google.com/calendar/ical/x/basic.ics", "https://calendar.google.com/calendar/ical/x/basic.ics"],
    ["http://example.com/cal.ics", "http://example.com/cal.ics"],
  ])("%s -> %s", (raw, expected) => {
    expect(normalizeCalendarUrl(raw)).toBe(expected);
  });
});

describe("fetchCalendarText", () => {
  const ICS = calendar([{ uid: "x@test", summary: "X" }]);

  /** A stand-in for safeGet that answers from a table and records every hop. */
  function scripted(table: Record<string, SafeResponse>) {
    const calls: { url: string; opts: SafeGetOptions }[] = [];
    const get = async (url: string, opts: SafeGetOptions) => {
      calls.push({ url, opts });
      const r = table[url];
      if (!r) throw new Error(`unexpected request to ${url}`);
      return r;
    };
    return { get, calls };
  }

  it("fetches a webcal link over https", async () => {
    const { get, calls } = scripted({
      "https://p01-calendarws.icloud.com/published/2/abc": response({ body: Buffer.from(ICS) }),
    });
    await expect(fetchCalendarText("webcal://p01-calendarws.icloud.com/published/2/abc", get)).resolves.toBe(ICS);
    expect(calls.map((c) => c.url)).toEqual(["https://p01-calendarws.icloud.com/published/2/abc"]);
  });

  it.each([301, 302, 303, 307, 308])("follows a %i to another host, then a relative Location", async (status) => {
    const { get, calls } = scripted({
      "https://p01-calendarws.icloud.com/published/2/abc": response({
        status,
        location: "https://p52-calendarws.icloud.com/published/2/abc",
      }),
      "https://p52-calendarws.icloud.com/published/2/abc": response({ status, location: "../3/abc?v=2" }),
      "https://p52-calendarws.icloud.com/published/3/abc?v=2": response({ body: Buffer.from(ICS) }),
    });
    await expect(fetchCalendarText("webcal://p01-calendarws.icloud.com/published/2/abc", get)).resolves.toBe(ICS);
    expect(calls.map((c) => c.url)).toEqual([
      "https://p01-calendarws.icloud.com/published/2/abc",
      "https://p52-calendarws.icloud.com/published/2/abc",
      "https://p52-calendarws.icloud.com/published/3/abc?v=2",
    ]);
    // Every hop gets the same limits (and, in production, safeGet's own checks).
    for (const c of calls) expect(c.opts).toMatchObject({ maxBytes: 10 * 1024 * 1024, timeoutMs: 30_000 });
  });

  it("follows three redirects but not a fourth", async () => {
    const chain = (hops: number) => {
      const table: Record<string, SafeResponse> = {};
      for (let i = 0; i < hops; i++) table[`https://a.example/${i}`] = response({ status: 302, location: `/${i + 1}` });
      table[`https://a.example/${hops}`] = response({ body: Buffer.from(ICS) });
      return scripted(table);
    };
    const three = chain(3);
    await expect(fetchCalendarText("https://a.example/0", three.get)).resolves.toBe(ICS);
    expect(three.calls).toHaveLength(4);

    const four = chain(4);
    await expect(fetchCalendarText("https://a.example/0", four.get)).rejects.toThrow(/more than 3 redirects/);
    expect(four.calls).toHaveLength(4);
  });

  it("refuses a redirect from https down to http, without requesting it", async () => {
    const { get, calls } = scripted({
      "https://a.example/cal.ics": response({ status: 302, location: "http://b.example/cal.ics" }),
      "http://b.example/cal.ics": response({ body: Buffer.from(ICS) }),
    });
    await expect(fetchCalendarText("https://a.example/cal.ics", get)).rejects.toThrow(/https to a non-https/);
    expect(calls.map((c) => c.url)).toEqual(["https://a.example/cal.ics"]);
  });

  it("refuses a redirect with no Location", async () => {
    const { get } = scripted({ "https://a.example/cal.ics": response({ status: 302 }) });
    await expect(fetchCalendarText("https://a.example/cal.ics", get)).rejects.toThrow(/without a Location/);
  });

  it("treats a 200 that is not a calendar as an error", async () => {
    const { get } = scripted({
      "https://a.example/cal.ics": response({ contentType: "text/html", body: Buffer.from(EXPIRED_PAGE) }),
    });
    await expect(fetchCalendarText("https://a.example/cal.ics", get)).rejects.toThrow(/did not return a calendar/);
  });

  it("uses safeGet by default, so a webcal link to a private address is still refused", async () => {
    await expect(fetchCalendarText("webcal://127.0.0.1/cal.ics")).rejects.toThrow(/private network/);
    await expect(fetchCalendarText("webcal://printer.local/cal.ics")).rejects.toThrow(/public address/);
  });
});
