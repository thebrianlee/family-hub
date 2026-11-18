import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@/lib/db";
import { MAX_INSTANCES_PER_EVENT, MAX_ROWS_PER_FEED, refreshIcs } from "@/lib/ics";
import { setSetting } from "@/lib/queries";
import type { SafeResponse } from "@/lib/safe-fetch";

// Small inline calendars, served from memory to the refresh.
const FEED = "https://cal.example/avery.ics";
let feedText = "";
const get = async (): Promise<SafeResponse> => ({
  status: 200,
  contentType: "text/calendar",
  location: null,
  body: Buffer.from(feedText),
});

function ics(...events: string[][]): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Sproutwall tests//EN"];
  for (const e of events) lines.push("BEGIN:VEVENT", "DTSTAMP:20260101T000000Z", ...e, "END:VEVENT");
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

/** UTC stamp ("20261118T150000Z") and ISO string of tomorrow at hh:00 UTC. */
function utc(hour: number, dayOffset = 1): { stamp: string; iso: string } {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(hour, 0, 0, 0);
  return { stamp: d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""), iso: d.toISOString() };
}

/** Local calendar day `offset` days from today: "20261124" and "2026-11-24". */
function localDay(offset: number): { compact: string; iso: string } {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { compact: iso.replace(/-/g, ""), iso };
}

type Stored = { id: string; title: string; date: string; start: string | null };
function rows(member = "avery"): Stored[] {
  return getDb()
    .prepare("SELECT id, title, date, start FROM synced_events WHERE member=? ORDER BY date, start, id")
    .all(member) as Stored[];
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  // The household timezone is America/Chicago (sample seed); the refresh shows
  // times in it.
  getDb().prepare("DELETE FROM synced_events").run();
  setSetting("ics_url_avery", FEED);
  setSetting("ics_url_jordan", "");
});

describe("EXDATE", () => {
  it("on a timed series removes only the excluded instant, not the whole day", async () => {
    const [h15, h16, h17, h18] = [15, 16, 17, 18].map((h) => utc(h));
    feedText = ics([
      "UID:hourly@test",
      `DTSTART:${h15.stamp}`,
      "DURATION:PT30M",
      "RRULE:FREQ=HOURLY;COUNT=4",
      `EXDATE:${h16.stamp}`,
      "SUMMARY:Check-in",
    ]);
    await refreshIcs(get);
    expect(rows().map((r) => r.id)).toEqual([h15, h17, h18].map((h) => `avery:hourly@test:${h.iso}`));
  });

  it("with a date only, on a timed series, still removes that day", async () => {
    const start = localDay(2);
    const skipped = localDay(3);
    feedText = ics([
      "UID:daily@test",
      `DTSTART;TZID=America/Chicago:${start.compact}T090000`,
      `DTEND;TZID=America/Chicago:${start.compact}T093000`,
      "RRULE:FREQ=DAILY;COUNT=3",
      `EXDATE;VALUE=DATE:${skipped.compact}`,
      "SUMMARY:Walk",
    ]);
    await refreshIcs(get);
    expect(rows().map((r) => [r.date, r.start])).toEqual([
      [start.iso, "09:00"],
      [localDay(4).iso, "09:00"],
    ]);
  });

  it("on an all-day series removes that day", async () => {
    const start = localDay(2);
    feedText = ics([
      "UID:allday@test",
      `DTSTART;VALUE=DATE:${start.compact}`,
      `DTEND;VALUE=DATE:${localDay(3).compact}`,
      "RRULE:FREQ=DAILY;COUNT=3",
      `EXDATE;VALUE=DATE:${localDay(3).compact}`,
      "SUMMARY:Camp",
    ]);
    await refreshIcs(get);
    expect(rows().map((r) => [r.date, r.start])).toEqual([
      [start.iso, null],
      [localDay(4).iso, null],
    ]);
  });
});

describe("a moved instance (RECURRENCE-ID)", () => {
  const series = (first: { compact: string }) => [
    "UID:lesson@test",
    `DTSTART;TZID=America/Chicago:${first.compact}T090000`,
    `DTEND;TZID=America/Chicago:${first.compact}T100000`,
    "RRULE:FREQ=WEEKLY;COUNT=3",
    "SUMMARY:Lesson",
  ];

  it("replaces the original occurrence instead of showing next to it", async () => {
    const [w1, w2, w3] = [3, 10, 17].map(localDay);
    const movedTo = localDay(11);
    feedText = ics(series(w1), [
      "UID:lesson@test",
      `RECURRENCE-ID;TZID=America/Chicago:${w2.compact}T090000`,
      `DTSTART;TZID=America/Chicago:${movedTo.compact}T140000`,
      `DTEND;TZID=America/Chicago:${movedTo.compact}T150000`,
      "SUMMARY:Lesson (moved)",
    ]);
    await refreshIcs(get);
    expect(rows().map((r) => [r.date, r.start, r.title])).toEqual([
      [w1.iso, "09:00", "Lesson"],
      [movedTo.iso, "14:00", "Lesson (moved)"],
      [w3.iso, "09:00", "Lesson"],
    ]);
    // Same row id as the occurrence it replaces.
    expect(rows().filter((r) => r.title === "Lesson (moved)").map((r) => r.id)).toHaveLength(1);
  });

  it("that is cancelled removes the occurrence", async () => {
    const [w1, w2, w3] = [3, 10, 17].map(localDay);
    feedText = ics(series(w1), [
      "UID:lesson@test",
      `RECURRENCE-ID;TZID=America/Chicago:${w2.compact}T090000`,
      `DTSTART;TZID=America/Chicago:${w2.compact}T090000`,
      `DTEND;TZID=America/Chicago:${w2.compact}T100000`,
      "STATUS:CANCELLED",
      "SUMMARY:Lesson",
    ]);
    await refreshIcs(get);
    expect(rows().map((r) => r.date)).toEqual([w1.iso, w3.iso]);
  });

  it("moved into the window from an occurrence outside it still shows", async () => {
    const first = localDay(3);
    const outside = localDay(3 + 7 * 30); // 30th week: past the ~4-month window
    const movedTo = localDay(5);
    feedText = ics(
      [
        "UID:club@test",
        `DTSTART;TZID=America/Chicago:${first.compact}T160000`,
        `DTEND;TZID=America/Chicago:${first.compact}T170000`,
        "RRULE:FREQ=WEEKLY;COUNT=40",
        "SUMMARY:Club",
      ],
      [
        "UID:club@test",
        `RECURRENCE-ID;TZID=America/Chicago:${outside.compact}T160000`,
        `DTSTART;TZID=America/Chicago:${movedTo.compact}T100000`,
        `DTEND;TZID=America/Chicago:${movedTo.compact}T110000`,
        "SUMMARY:Club (rescheduled)",
      ]
    );
    await refreshIcs(get);
    expect(rows().filter((r) => r.date === movedTo.iso).map((r) => [r.start, r.title])).toEqual([
      ["10:00", "Club (rescheduled)"],
    ]);
  });
});

describe("recurrence expansion bounds", () => {
  it(`keeps the earliest ${MAX_INSTANCES_PER_EVENT} instances of one event`, async () => {
    const start = utc(15);
    feedText = ics(["UID:every-hour@test", `DTSTART:${start.stamp}`, "DURATION:PT15M", "RRULE:FREQ=HOURLY", "SUMMARY:Ping"]);
    expect(feedText.length).toBeLessThan(250);
    await refreshIcs(get);
    const ids = rows().map((r) => r.id);
    expect(ids).toHaveLength(MAX_INSTANCES_PER_EVENT);
    expect(ids[0]).toBe(`avery:every-hour@test:${start.iso}`);
    const last = new Date(new Date(start.iso).getTime() + (MAX_INSTANCES_PER_EVENT - 1) * 3_600_000).toISOString();
    expect(ids[ids.length - 1]).toBe(`avery:every-hour@test:${last}`);
  });

  it("stops a dense rule early instead of failing the feed or expanding it for months", async () => {
    const minutes = Array.from({ length: 60 }, (_, i) => i).join(",");
    const hours = Array.from({ length: 24 }, (_, i) => i).join(",");
    feedText = ics(
      ["UID:minutely@test", `DTSTART:${utc(15).stamp}`, "RRULE:FREQ=MINUTELY", "SUMMARY:Tick"],
      ["UID:byminute@test", `DTSTART:${utc(0).stamp}`, `RRULE:FREQ=DAILY;BYHOUR=${hours};BYMINUTE=${minutes}`, "SUMMARY:Tock"]
    );
    const started = Date.now();
    await refreshIcs(get);
    expect(Date.now() - started).toBeLessThan(5000);
    const count = (title: string) => rows().filter((r) => r.title === title).length;
    expect(count("Tick")).toBe(MAX_INSTANCES_PER_EVENT);
    expect(count("Tock")).toBe(MAX_INSTANCES_PER_EVENT);
  });

  it(`keeps the earliest ${MAX_ROWS_PER_FEED} rows of a feed, and says so once`, async () => {
    // A member whose feed has not been capped before in this process.
    setSetting("ics_url_avery", "");
    setSetting("ics_url_jordan", "https://cal.example/jordan.ics");
    warn.mockClear();
    // Eleven hourly events, each capped at 500: 5,500 rows before the feed cap.
    const events = Array.from({ length: 11 }, (_, i) => [
      `UID:e${i}@test`,
      `DTSTART:${utc(i).stamp}`,
      "DURATION:PT5M",
      "RRULE:FREQ=HOURLY",
      `SUMMARY:E${i}`,
    ]);
    feedText = ics(...events);
    await refreshIcs(get);
    const stored = rows("jordan");
    expect(stored).toHaveLength(MAX_ROWS_PER_FEED);
    // The rows dropped are the latest ones: nothing kept is later than any row dropped.
    const all = events.flatMap((_, i) =>
      Array.from({ length: MAX_INSTANCES_PER_EVENT }, (_, n) => new Date(new Date(utc(i).iso).getTime() + n * 3_600_000).getTime())
    );
    all.sort((a, b) => a - b);
    const keptLatest = Math.max(...stored.map((r) => new Date(r.id.split(":").slice(2).join(":")).getTime()));
    expect(keptLatest).toBeLessThanOrEqual(all[MAX_ROWS_PER_FEED - 1]);

    await refreshIcs(get);
    const capWarnings = warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes("kept the earliest"));
    expect(capWarnings).toEqual([[expect.stringMatching(/^\[ics\] jordan: .* and the earliest 5000 rows of the feed$/)]]);
  });
});
