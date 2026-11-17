import { beforeAll, describe, expect, it, vi } from "vitest";

// The feeds are served from memory: no network in tests.
const feeds = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/safe-fetch", () => ({
  safeGet: vi.fn(async (url: string) => {
    const text = feeds.get(url);
    return text === undefined
      ? { status: 404, contentType: "text/plain", location: null, body: Buffer.from("") }
      : { status: 200, contentType: "text/calendar", location: null, body: Buffer.from(text) };
  }),
}));

import { getDb } from "@/lib/db";
import { replaceHousehold, validateHousehold } from "@/lib/household";
import { refreshIcsNow, sharedFeedTargets, stripNamePrefix } from "@/lib/ics";
import { setSetting } from "@/lib/queries";

function ics(titles: string[]): string {
  const d = new Date(Date.now() + 2 * 86_400_000);
  const day = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  const events = titles.map(
    (title, i) =>
      `BEGIN:VEVENT\r\nUID:e${i}-${title.length}@test\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:${day}T15${String(i).padStart(2, "0")}00Z\r\nDTEND:${day}T16${String(i).padStart(2, "0")}00Z\r\nSUMMARY:${title}\r\nEND:VEVENT`
  );
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n${events.join("\r\n")}\r\nEND:VCALENDAR\r\n`;
}

function rows(member: string): string[] {
  return (
    getDb().prepare("SELECT title FROM synced_events WHERE member=? ORDER BY title").all(member) as { title: string }[]
  ).map((r) => r.title);
}

describe("name-prefix routing helpers", () => {
  const kids = [
    { id: "a-j", name: "A.J." },
    { id: "bo", name: "Bo" },
    { id: "bobby", name: "Bobby" },
  ];
  it("route a prefixed title to that kid only, anything else to every kid", () => {
    expect(sharedFeedTargets("Bo - Swim", kids)).toEqual(["bo"]);
    expect(sharedFeedTargets("bobby: Chess", kids)).toEqual(["bobby"]);
    expect(sharedFeedTargets("A.J. – Piano", kids)).toEqual(["a-j"]);
    // Names are matched literally, not as patterns.
    expect(sharedFeedTargets("AxJx - Piano", kids)).toEqual(["a-j", "bo", "bobby"]);
    expect(sharedFeedTargets("Bowling night", kids)).toEqual(["a-j", "bo", "bobby"]);
  });
  it("strip only the member's own name", () => {
    expect(stripNamePrefix("Bo - Swim", "Bo")).toBe("Swim");
    expect(stripNamePrefix("Bo - Swim", "Bobby")).toBe("Bo - Swim");
    expect(stripNamePrefix("Bo -", "Bo")).toBe("Bo -");
    expect(stripNamePrefix("Swim", undefined)).toBe("Swim");
  });
});

describe("ICS refresh uses the household in the database", () => {
  beforeAll(() => {
    replaceHousehold(
      validateHousehold({
        kids: [
          { name: "Mila", age: 9, color: "#C2738A" },
          { name: "Théo", age: 4, color: "#4E978F" },
        ],
        parents: [{ name: "Dana", color: "#5E7B86" }],
      })
    );
    feeds.set("https://cal.example/kids.ics", ics(["Mila - Piano", "Théo: Swim", "Riley - Chess", "Pancakes"]));
    feeds.set("https://cal.example/dana.ics", ics(["Dana - Dentist", "Mila - Pickup"]));
    setSetting("ics_url_kids_shared", "https://cal.example/kids.ics");
    setSetting("ics_url_dana", "https://cal.example/dana.ics");
    // A key for someone who is not a member is ignored.
    setSetting("ics_url_riley", "https://cal.example/missing.ics");
  });

  it("routes the shared feed by the members' names and strips their prefixes", async () => {
    await refreshIcsNow();
    expect(rows("mila")).toEqual(["Pancakes", "Piano", "Riley - Chess"]);
    expect(rows("theo")).toEqual(["Pancakes", "Riley - Chess", "Swim"]);
    // A parent's own feed: their prefix is stripped, another member's is not.
    expect(rows("dana")).toEqual(["Dentist", "Mila - Pickup"]);
    expect(rows("riley")).toEqual([]);
  });
});
