import { describe, expect, it } from "vitest";

import { applyHouseholdTimezone, getDb } from "@/lib/db";
import { isoToday, setSetting } from "@/lib/queries";

describe("household timezone", () => {
  it("drives today's date and SQLite localtime, not the container clock", () => {
    process.env.TZ = "UTC";
    setSetting("timezone", "America/Chicago");
    applyHouseholdTimezone();
    expect(process.env.TZ).toBe("America/Chicago");

    // 02:00 UTC on Nov 17 is still the evening of Nov 16 in Chicago.
    expect(isoToday(new Date("2026-11-17T02:00:00Z"))).toBe("2026-11-16");
    const row = getDb().prepare("SELECT datetime('2026-11-17 02:00:00','localtime') t").get() as { t: string };
    expect(row.t).toBe("2026-11-16 20:00:00");
  });

  it("ignores an invalid timezone", () => {
    process.env.TZ = "UTC";
    setSetting("timezone", "Not/AZone");
    applyHouseholdTimezone();
    expect(process.env.TZ).toBe("UTC");
  });
});
