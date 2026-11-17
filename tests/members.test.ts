import { describe, expect, it } from "vitest";

import { getDb } from "@/lib/db";
import {
  MemberError,
  addMember,
  getKids,
  getMember,
  getMembers,
  getParents,
  isKidId,
  isMemberId,
  isParentId,
  removeMember,
  slugifyName,
  uniqueMemberId,
  updateMember,
  validateHousehold,
} from "@/lib/household";

describe("the members table", () => {
  it("starts with the sample family: same names, ages, readers, colors and order", () => {
    expect(getMembers()).toEqual([
      { id: "riley", name: "Riley", role: "kid", age: 11, preReader: false, color: "#6E9BBD" },
      { id: "quinn", name: "Quinn", role: "kid", age: 8, preReader: false, color: "#7FA576" },
      { id: "sam", name: "Sam", role: "kid", age: 5, preReader: true, color: "#D9A254" },
      { id: "avery", name: "Avery", role: "parent", age: null, preReader: false, color: "#5E7B86" },
      { id: "jordan", name: "Jordan", role: "parent", age: null, preReader: false, color: "#8A6D9E" },
    ]);
    expect(getKids().map((k) => k.id)).toEqual(["riley", "quinn", "sam"]);
    expect(getParents().map((p) => p.id)).toEqual(["avery", "jordan"]);
  });

  it("enforces its column rules in SQL too", () => {
    const db = getDb();
    expect(() =>
      db.prepare("INSERT INTO members (id, name, role, color, sort) VALUES ('x', 'X', 'pet', '#6E9BBD', 1)").run()
    ).toThrow(/CHECK/);
    expect(() =>
      db.prepare("INSERT INTO members (id, name, role, color, sort) VALUES ('riley', 'Riley 2', 'kid', '#6E9BBD', 1)").run()
    ).toThrow(/UNIQUE|PRIMARY/);
  });

  it("checks ids against the database, by role", () => {
    expect(isKidId("riley")).toBe(true);
    expect(isKidId("avery")).toBe(false);
    expect(isParentId("avery")).toBe(true);
    expect(isParentId("riley")).toBe(false);
    expect(isMemberId("jordan")).toBe(true);
    for (const bad of ["nobody", "", "Riley", "riley ", "../riley", null, 7, { id: "riley" }]) {
      expect(isMemberId(bad)).toBe(false);
      expect(isKidId(bad)).toBe(false);
    }
  });
});

describe("member ids", () => {
  it("are CSS-safe slugs derived from the name", () => {
    expect(slugifyName("Zoë Ann")).toBe("zoe-ann");
    expect(slugifyName("  Mary-Kate  O'Neil ")).toBe("mary-kate-o-neil");
    expect(slugifyName("3rd Kid")).toBe("m-3rd-kid");
    expect(slugifyName("李")).toBe("member");
    expect(slugifyName("A".repeat(40))).toBe("a".repeat(24));
    for (const name of ["Zoë Ann", "3rd Kid", "李", "x".repeat(30), "<script>"]) {
      expect(slugifyName(name)).toMatch(/^[a-z][a-z0-9-]{0,23}$/);
    }
  });

  it("are made unique, and never take a reserved id", () => {
    const taken = new Set(["mila", "mila-2"]);
    expect(uniqueMemberId("Mila", taken)).toBe("mila-3");
    expect(uniqueMemberId("Guest", new Set())).toBe("guest-2");
    const long = "b".repeat(30);
    const id = uniqueMemberId(long, new Set(["b".repeat(24)]));
    expect(id).toBe(`${"b".repeat(22)}-2`);
    expect(id.length).toBeLessThanOrEqual(24);
  });
});

describe("adding, changing and removing members", () => {
  it("adds a valid kid and parent with unique ids", () => {
    const kid = addMember({ name: "Mila", age: 9, color: "#c2738a" }, "kid");
    expect(kid).toEqual({ id: "mila", name: "Mila", role: "kid", age: 9, preReader: false, color: "#C2738A" });
    expect(isKidId("mila")).toBe(true);
    expect(getKids().map((k) => k.id)).toEqual(["riley", "quinn", "sam", "mila"]);

    const parent = addMember({ name: "Dana", color: "#4E978F", age: 40 }, "parent");
    expect(parent.age).toBeNull(); // parents have no age
    expect(isParentId("dana")).toBe(true);
    expect(getDb().prepare("SELECT status FROM parent_status WHERE member='dana'").get()).toEqual({ status: "Home" });
  });

  it("rejects bad names, ages, colors and duplicate names", () => {
    const bad: [unknown, "kid" | "parent"][] = [
      [{ name: "", age: 5, color: "#6E9BBD" }, "kid"],
      [{ name: "   ", age: 5, color: "#6E9BBD" }, "kid"],
      [{ name: "x".repeat(31), age: 5, color: "#6E9BBD" }, "kid"],
      [{ name: "Bell\u0007", age: 5, color: "#6E9BBD" }, "kid"],
      [{ name: "<b>", age: 5, color: "#6E9BBD" }, "kid"],
      [{ name: "Ada", age: 19, color: "#6E9BBD" }, "kid"],
      [{ name: "Ada", age: -1, color: "#6E9BBD" }, "kid"],
      [{ name: "Ada", age: 2.5, color: "#6E9BBD" }, "kid"],
      [{ name: "Ada", color: "#6E9BBD" }, "kid"],
      [{ name: "Ada", age: 5, color: "#000000" }, "kid"],
      [{ name: "Ada", age: 5, color: "red" }, "kid"],
      [{ name: "Ada", age: 5 }, "kid"],
      [{ name: "riley", age: 5, color: "#6E9BBD" }, "kid"], // same name as Riley
      [null, "parent"],
    ];
    for (const [input, role] of bad) {
      expect(() => addMember(input, role)).toThrow(MemberError);
    }
    expect(getMember("ada")).toBeNull();
    // 30 characters is fine.
    expect(addMember({ name: "y".repeat(30), age: 0, color: "#6C79B8" }, "kid").name).toHaveLength(30);
  });

  it("updates a member without changing the id", () => {
    const m = updateMember("quinn", { name: "Quinny", age: 9, color: "#B5785A", preReader: true });
    expect(m).toEqual({ id: "quinn", name: "Quinny", role: "kid", age: 9, preReader: true, color: "#B5785A" });
    expect(() => updateMember("quinn", { age: 40 })).toThrow(MemberError);
    expect(() => updateMember("quinn", { name: "Riley" })).toThrow(MemberError);
    expect(() => updateMember("nobody", { name: "X" })).toThrow(MemberError);
    expect(getMember("quinn")?.name).toBe("Quinny");
  });

  it("removing a member hides them from every check, keeps their history and their id", () => {
    expect(removeMember("sam")).toBe(true);
    expect(isKidId("sam")).toBe(false);
    expect(getKids().map((k) => k.id)).not.toContain("sam");
    const history = getDb().prepare("SELECT COUNT(*) c FROM ledger WHERE kid='sam'").get() as { c: number };
    expect(history.c).toBeGreaterThan(0);
    expect(removeMember("sam")).toBe(false);
    // A new Sam does not reuse the old id.
    expect(addMember({ name: "Sam", age: 6, color: "#D9A254" }, "kid").id).toBe("sam-2");
  });
});

describe("validating a whole household", () => {
  const kid = (name: string, age = 7) => ({ name, age, color: "#6E9BBD" });
  const parent = (name: string) => ({ name, color: "#5E7B86" });

  it("takes 1-8 kids and 1-4 parents", () => {
    expect(validateHousehold({ kids: [kid("A")], parents: [parent("P")] }).kids).toHaveLength(1);
    const eight = Array.from({ length: 8 }, (_, i) => kid(`Kid ${i}`));
    const four = Array.from({ length: 4 }, (_, i) => parent(`Parent ${i}`));
    expect(validateHousehold({ kids: eight, parents: four }).parents).toHaveLength(4);

    expect(() => validateHousehold({ kids: [], parents: [parent("P")] })).toThrow(MemberError);
    expect(() => validateHousehold({ kids: [...eight, kid("Nine")], parents: [parent("P")] })).toThrow(MemberError);
    expect(() => validateHousehold({ kids: [kid("A")], parents: [] })).toThrow(MemberError);
    expect(() => validateHousehold({ kids: [kid("A")], parents: [...four, parent("Five")] })).toThrow(MemberError);
    expect(() => validateHousehold({ kids: [kid("Alex")], parents: [parent("alex")] })).toThrow(/different name/);
    expect(() => validateHousehold("nope")).toThrow(MemberError);
  });

  it("accepts ages given as digit strings, and only the offered colors", () => {
    expect(validateHousehold({ kids: [{ name: "A", age: "4", color: "#7FA576" }], parents: [parent("P")] }).kids[0].age).toBe(4);
    expect(() =>
      validateHousehold({ kids: [{ name: "A", age: 4, color: "#123456" }], parents: [parent("P")] })
    ).toThrow(/color/);
  });
});

describe("member ids, hiding and shared-feed routing", () => {
  it("never gives a member an id that is also a Tailwind margin utility", async () => {
    const { uniqueMemberId } = await import("@/lib/household");
    expect(uniqueMemberId("Auto", new Set())).toBe("auto-2");
    expect(uniqueMemberId("PX", new Set())).toBe("px-2");
  });

  it("hiding a member deletes their secret calendar link and its synced events", async () => {
    const { addMember, removeMember } = await import("@/lib/household");
    const { getDb } = await import("@/lib/db");
    const { getSetting, setSetting } = await import("@/lib/queries");
    const m = addMember({ name: "Temp Kid", age: 9, color: "#4E978F" }, "kid");
    setSetting(`ics_url_${m.id}`, "https://calendar.example.com/secret.ics");
    getDb()
      .prepare("INSERT INTO synced_events (id, member, title, date, start, end, location) VALUES (?, ?, 'Swim', '2026-11-20', NULL, NULL, NULL)")
      .run(`${m.id}:x`, m.id);
    expect(removeMember(m.id)).toBe(true);
    expect(getSetting(`ics_url_${m.id}`)).toBe("");
    expect(getDb().prepare("SELECT COUNT(*) n FROM synced_events WHERE member=?").get(m.id)).toEqual({ n: 0 });
  });

  it("routes a shared-feed event to the longest matching name", async () => {
    const { sharedFeedTargets } = await import("@/lib/ics");
    const kids = [
      { id: "jo", name: "Jo" },
      { id: "jo-ann", name: "Jo-Ann" },
    ];
    expect(sharedFeedTargets("Jo-Ann - Swim", kids)).toEqual(["jo-ann"]);
    expect(sharedFeedTargets("Jo - Piano", kids)).toEqual(["jo"]);
  });
});
