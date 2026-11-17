import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { POST } from "@/app/api/setup/route";
import { verifyPin } from "@/lib/auth";
import { getSetting } from "@/lib/queries";

function setupRequest(pin: string, familyName: string): NextRequest {
  return new NextRequest("http://localhost/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pin,
      familyName,
      greeting: familyName,
      currency: "Stars",
      timezone: "America/Chicago",
      latitude: 39.1,
      longitude: -94.6,
    }),
  });
}

function storedPinMatches(pin: string): boolean {
  const [salt, hash] = getSetting("parent_pin").split(":");
  return verifyPin(pin, { salt, hash, updatedAt: "" });
}

describe("first-run setup", () => {
  it("lets exactly one of two racing claims win, and keeps the winner's PIN", async () => {
    expect(getSetting("setup_complete")).toBe("0");

    // Both handlers pass the up-front "already set up?" check before either
    // has read its body, so only the check inside the transaction can stop
    // the second one from overwriting the first.
    const [a, b] = await Promise.all([POST(setupRequest("2468", "Ashford")), POST(setupRequest("9713", "Bramley"))]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);

    const [winner, loser] = a.status === 200 ? [["2468", "Ashford"], ["9713", "Bramley"]] : [["9713", "Bramley"], ["2468", "Ashford"]];
    expect(storedPinMatches(winner[0])).toBe(true);
    expect(storedPinMatches(loser[0])).toBe(false);
    expect(getSetting("family_name")).toBe(winner[1]);
    expect(getSetting("setup_complete")).toBe("1");
    expect(await (a.status === 200 ? b : a).json()).toEqual({ error: "This hub is already set up." });

    // A later attempt is refused up front and changes nothing.
    const late = await POST(setupRequest("1357", "Carrow"));
    expect(late.status).toBe(409);
    expect(storedPinMatches(winner[0])).toBe(true);
    expect(getSetting("family_name")).toBe(winner[1]);
  });
});
