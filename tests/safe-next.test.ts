import { describe, expect, it } from "vitest";

import { safeNext } from "@/lib/safe-next";

const ORIGIN = "http://hub.home:3847";

describe("unlock ?next= redirect target", () => {
  it("keeps paths on this hub", () => {
    expect(safeNext("/calendar", ORIGIN)).toBe("/calendar");
    expect(safeNext("/my-day?kid=x#top", ORIGIN)).toBe("/my-day?kid=x#top");
  });

  it("refuses every way of naming another site", () => {
    for (const raw of [
      "//evil.example",
      "/\\evil.example",
      "/\\\\evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
      "https://evil.example/x",
      "http:evil.example",
      "javascript:alert(1)",
      "evil.example",
      "",
      null,
    ]) {
      expect(safeNext(raw, ORIGIN)).toBe("/today");
    }
  });
});
