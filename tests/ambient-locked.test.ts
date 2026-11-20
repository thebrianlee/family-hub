import { describe, expect, it } from "vitest";

import { ambientConfigFrom } from "@/components/Ambient";

// The unlock page renders inside the screensaver wrapper. On a screen that is
// not unlocked yet, /api/ambient answers 401 with an error body. That body must
// never be used as screensaver settings: it crashed the unlock page, so a new
// install could not be unlocked.

const settings = {
  photos: [],
  art: ["/art/a.png"],
  quotes: [{ kind: "rule", text: "Be kind." }],
  idleMinutes: 10,
  sleepStart: "21:30",
  sleepEnd: "06:00",
};

describe("ambientConfigFrom", () => {
  it("ignores the 401 answer a locked screen gets", () => {
    expect(ambientConfigFrom(false, { error: "Unlock this screen first." })).toBeNull();
  });

  it("ignores a failed answer even if it looks like settings", () => {
    expect(ambientConfigFrom(false, settings)).toBeNull();
  });

  it("ignores a body that is not settings", () => {
    expect(ambientConfigFrom(true, null)).toBeNull();
    expect(ambientConfigFrom(true, "nope")).toBeNull();
    expect(ambientConfigFrom(true, { photos: [], art: [] })).toBeNull();
    expect(ambientConfigFrom(true, { ...settings, idleMinutes: "10" })).toBeNull();
  });

  it("uses real settings", () => {
    expect(ambientConfigFrom(true, settings)).toEqual(settings);
  });
});
