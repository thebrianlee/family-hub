import { describe, expect, it } from "vitest";

import { calendarProvider } from "@/lib/calendar";
import { getDb } from "@/lib/db";
import { setSetting } from "@/lib/queries";

describe("Today's calendar", () => {
  it("shows the sample week while no calendar link is set", async () => {
    getDb().prepare("DELETE FROM synced_events").run();
    const events = await calendarProvider.getWeekEvents(new Date());
    expect(events.length).toBeGreaterThan(0);
  });

  it("never shows sample events once a real calendar is linked, even if it is empty", async () => {
    getDb().prepare("DELETE FROM synced_events").run();
    getDb().prepare("DELETE FROM wall_events").run();
    setSetting("ics_url_avery", "https://calendar.example/secret.ics");
    const events = await calendarProvider.getWeekEvents(new Date());
    expect(events).toEqual([]);
  });
});
