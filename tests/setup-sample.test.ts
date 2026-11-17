import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { POST as setupPost } from "@/app/api/setup/route";
import { getDb } from "@/lib/db";
import { getMembers } from "@/lib/household";
import { getSetting } from "@/lib/queries";

const HOST = "hub.home:3847";

function setup(body: Record<string, unknown>) {
  return setupPost(
    new NextRequest(`http://${HOST}/api/setup`, {
      method: "POST",
      headers: { host: HOST, origin: `http://${HOST}`, "content-type": "application/json" },
      body: JSON.stringify({
        pin: "5938",
        familyName: "The Calder family",
        greeting: "Calders",
        currency: "Family Bucks",
        timezone: "America/Chicago",
        latitude: "39.10",
        longitude: "-94.58",
        ...body,
      }),
    })
  );
}

function count(sql: string): number {
  return (getDb().prepare(sql).get() as { c: number }).c;
}

const kid = (name: string, age: number) => ({ name, age, color: "#6E9BBD" });
const parent = (name: string) => ({ name, color: "#5E7B86" });

describe("setup: Your family", () => {
  it("rejects a bad household before claiming setup, and leaves the sample family alone", async () => {
    const bad: unknown[] = [
      { mode: "sideways" },
      null,
      { mode: "custom", kids: [], parents: [parent("Dana")] },
      { mode: "custom", kids: [kid("Mila", 9)], parents: [] },
      { mode: "custom", kids: Array.from({ length: 9 }, (_, i) => kid(`Kid ${i}`, 5)), parents: [parent("Dana")] },
      { mode: "custom", kids: [kid("Mila", 9)], parents: Array.from({ length: 5 }, (_, i) => parent(`P ${i}`)) },
      { mode: "custom", kids: [kid("x".repeat(31), 9)], parents: [parent("Dana")] },
      { mode: "custom", kids: [kid("", 9)], parents: [parent("Dana")] },
      { mode: "custom", kids: [kid("Mila", 19)], parents: [parent("Dana")] },
      { mode: "custom", kids: [kid("Mila", 3.5)], parents: [parent("Dana")] },
      { mode: "custom", kids: [{ name: "Mila", age: 9, color: "#000000" }], parents: [parent("Dana")] },
      { mode: "custom", kids: [kid("Mila", 9)], parents: [{ name: "Dana", color: "pink" }] },
      { mode: "custom", kids: [kid("Mila", 9), kid("MILA", 4)], parents: [parent("Dana")] },
    ];
    for (const household of bad) {
      const res = await setup({ household });
      expect(res.status, JSON.stringify(household)).toBe(400);
    }
    expect(getSetting("setup_complete", "0")).toBe("0");
    expect(getMembers().map((m) => m.id)).toEqual(["riley", "quinn", "sam", "avery", "jordan"]);
  });

  it("option A keeps the Calders and their sample routines, events and points", async () => {
    const before = {
      templates: count("SELECT COUNT(*) c FROM checklist_templates"),
      events: count("SELECT COUNT(*) c FROM events"),
      ledger: count("SELECT COUNT(*) c FROM ledger"),
      books: count("SELECT COUNT(*) c FROM books"),
    };
    expect(before.templates).toBeGreaterThan(0);
    const res = await setup({ household: { mode: "sample" } });
    expect(res.status).toBe(200);
    expect(getSetting("setup_complete")).toBe("1");
    expect(getMembers()).toHaveLength(5);
    expect(getMembers().map((m) => m.name)).toEqual(["Riley", "Quinn", "Sam", "Avery", "Jordan"]);
    expect({
      templates: count("SELECT COUNT(*) c FROM checklist_templates"),
      events: count("SELECT COUNT(*) c FROM events"),
      ledger: count("SELECT COUNT(*) c FROM ledger"),
      books: count("SELECT COUNT(*) c FROM books"),
    }).toEqual(before);
    expect(count("SELECT COUNT(*) c FROM checklist_templates WHERE kid='riley'")).toBeGreaterThan(0);
    expect(count("SELECT COUNT(*) c FROM parent_status WHERE member IN ('avery','jordan')")).toBe(2);
  });

  it("a second setup is refused and cannot replace the family afterwards", async () => {
    const res = await setup({ household: { mode: "custom", kids: [kid("Mila", 9)], parents: [parent("Dana")] } });
    expect(res.status).toBe(409);
    expect(getMembers().map((m) => m.id)).toEqual(["riley", "quinn", "sam", "avery", "jordan"]);
  });
});
