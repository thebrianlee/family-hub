import { describe, expect, it } from "vitest";

import { buildHousehold, MemberRecord } from "@/lib/family";
import {
  MEMBER_PALETTE,
  PARENT_THEME,
  cssEscapeIdent,
  darken,
  memberShades,
  memberTheme,
  memberThemeCss,
  mixWithWhite,
  nextUnusedColor,
} from "@/lib/member-theme";

const SAMPLE: MemberRecord[] = [
  { id: "riley", name: "Riley", role: "kid", age: 11, preReader: false, color: "#6E9BBD" },
  { id: "quinn", name: "Quinn", role: "kid", age: 8, preReader: false, color: "#7FA576" },
  { id: "sam", name: "Sam", role: "kid", age: 5, preReader: true, color: "#D9A254" },
  { id: "avery", name: "Avery", role: "parent", age: null, preReader: false, color: "#5E7B86" },
  { id: "jordan", name: "Jordan", role: "parent", age: null, preReader: false, color: "#8A6D9E" },
];

const RULE = /^\.m-[a-z][a-z0-9-]{0,23}\{--member:#[0-9A-F]{6};--member-deep:#[0-9A-F]{6};--member-soft:#[0-9A-F]{6};--member-tint:#[0-9A-F]{6}\}$/;

describe("member theme CSS", () => {
  it("writes one valid rule per member, with the sample kids' old token colors", () => {
    const css = memberThemeCss(SAMPLE);
    const lines = css.split("\n");
    expect(lines).toHaveLength(5);
    for (const line of lines) expect(line).toMatch(RULE);
    // The exact values the riley/quinn/sam Tailwind tokens had.
    expect(lines[0]).toBe(".m-riley{--member:#6E9BBD;--member-deep:#3E6D8F;--member-soft:#E2ECF4;--member-tint:#F0F5F9}");
    expect(lines[1]).toBe(".m-quinn{--member:#7FA576;--member-deep:#4E7448;--member-soft:#E4EEE0;--member-tint:#F1F6EF}");
    expect(lines[2]).toBe(".m-sam{--member:#D9A254;--member-deep:#A0702B;--member-soft:#F6E8D0;--member-tint:#FAF2E4}");
    // Balanced braces: nothing can open a second block.
    expect(css.split("{").length).toBe(css.split("}").length);
  });

  it("refuses ids that are not slugs and colors that are not #RRGGBB, and never emits '<'", () => {
    const css = memberThemeCss([
      { id: "x}</style><script>alert(1)</script>", color: "#6E9BBD" },
      { id: "Riley", color: "#6E9BBD" },
      { id: "a b", color: "#6E9BBD" },
      { id: "1abc", color: "#6E9BBD" },
      { id: "", color: "#6E9BBD" },
      { id: "ok", color: "red;background:url(x)" },
      { id: "ok2", color: "#6E9BBD}body{display:none" },
      { id: "fine", color: "#c2738a" },
    ]);
    expect(css).not.toContain("<");
    expect(css).not.toContain("script");
    expect(css.split("\n")).toEqual([
      ".m-fine{--member:#C2738A;--member-deep:#8C3D54;--member-soft:#F3E3E8;--member-tint:#F9F1F3}",
    ]);
    expect(memberThemeCss([])).toBe("");
  });

  it("escapes characters that are not safe in a class selector", () => {
    expect(cssEscapeIdent("m-riley")).toBe("m-riley");
    expect(cssEscapeIdent("a b")).toBe("a\\20 b");
    expect(cssEscapeIdent("x</style>")).not.toMatch(/[<>/]/);
    expect(cssEscapeIdent("1a")).toBe("\\31 a");
  });
});

describe("member shades", () => {
  it("derive deep, soft and tint from any palette color", () => {
    for (const { hex } of MEMBER_PALETTE) {
      const s = memberShades(hex);
      const lum = (h: string) => parseInt(h.slice(1, 3), 16) + parseInt(h.slice(3, 5), 16) + parseInt(h.slice(5, 7), 16);
      expect(lum(s.deep)).toBeLessThan(lum(s.base));
      expect(lum(s.soft)).toBeGreaterThan(lum(s.base));
      expect(lum(s.tint)).toBeGreaterThan(lum(s.soft));
    }
    expect(mixWithWhite("#000000", 0.8)).toBe("#CCCCCC");
    expect(mixWithWhite("#6E9BBD", 0)).toBe("#6E9BBD");
    expect(darken("#FFFFFF", 0.35)).toBe("#A6A6A6");
  });

  it("pick the next unused palette color, cycling when all are taken", () => {
    expect(nextUnusedColor([])).toBe(MEMBER_PALETTE[0].hex);
    expect(nextUnusedColor(["#6e9bbd"])).toBe(MEMBER_PALETTE[1].hex);
    const all = MEMBER_PALETTE.map((p) => p.hex);
    expect(all).toContain(nextUnusedColor(all));
  });
});

describe("themes and the client household", () => {
  it("kid themes are class strings on the member's own class; parents keep the parent look", () => {
    expect(memberTheme("riley", "#6E9BBD")).toEqual({
      bg: "m-riley bg-member",
      bgSoft: "m-riley bg-member-soft",
      bgTint: "m-riley bg-member-tint",
      text: "m-riley text-member-deep",
      textDeep: "m-riley text-member-deep",
      border: "m-riley border-member",
      fill: "#6E9BBD",
      fillSoft: "#E2ECF4",
    });
    // A bad id never becomes a class name.
    expect(memberTheme("a b", "#6E9BBD")).toBe(PARENT_THEME);

    const h = buildHousehold(SAMPLE);
    expect(h.kids.map((k) => k.name)).toEqual(["Riley", "Quinn", "Sam"]);
    expect(h.parents.map((p) => p.theme)).toEqual([PARENT_THEME, PARENT_THEME]);
    expect(h.rowOrder.map((m) => m.id)).toEqual(["riley", "quinn", "sam", "avery", "jordan"]);
    expect(h.byId.sam?.preReader).toBe(true);
    expect(h.byId.nobody).toBeUndefined();
    expect(h.memberOf("nobody")).toMatchObject({ id: "nobody", name: "nobody", theme: PARENT_THEME });
    // Ids such as "constructor" are not inherited object keys.
    expect(h.byId.constructor).toBeUndefined();
  });
});
