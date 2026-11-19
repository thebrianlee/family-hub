import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  MODULES,
  TOGGLEABLE_MODULES,
  applyModuleChanges,
  defaultModuleState,
  moduleForPath,
  type ModuleManifestV0,
} from "@/modules/registry";

const ALL = MODULES as readonly ModuleManifestV0[];
const APP = path.resolve(__dirname, "../src/app");

/** Every page and route handler under src/app, as a request path. */
function appRoutes(): { pages: string[]; api: string[] } {
  const pages: string[] = [];
  const api: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "page.tsx" || entry.name === "route.ts") {
        const rel = path.relative(APP, dir).split(path.sep).filter(Boolean);
        // Dynamic segments ([file]) get a sample value.
        const url = "/" + rel.map((s) => (s.startsWith("[") ? "sample.jpg" : s)).join("/");
        (entry.name === "page.tsx" ? pages : api).push(url);
      }
    }
  };
  walk(APP);
  return { pages, api };
}

describe("module registry", () => {
  it("has unique, lowercase ids", () => {
    const ids = ALL.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it("gives every page and api prefix to exactly one module", () => {
    const owner = new Map<string, string[]>();
    for (const m of ALL) for (const p of [...m.pages, ...m.api]) owner.set(p, [...(owner.get(p) ?? []), m.id]);
    for (const [prefix, ids] of owner) {
      expect({ prefix, ids }).toEqual({ prefix, ids: [ids[0]] });
      expect(moduleForPath(prefix)?.id).toBe(ids[0]);
    }
    for (const m of ALL) {
      for (const p of m.pages) expect(p.startsWith("/api")).toBe(false);
      for (const p of m.api) expect(p.startsWith("/api/")).toBe(true);
    }
  });

  it("covers every page and API route in src/app (no orphan routes)", () => {
    const { pages, api } = appRoutes();
    expect(pages.length).toBeGreaterThan(10);
    expect(api.length).toBeGreaterThan(20);
    const orphans = [...pages, ...api].filter((p) => !moduleForPath(p));
    expect(orphans).toEqual([]);
  });

  it("matches whole path segments, longest prefix first", () => {
    const owner = (p: string) => moduleForPath(p)?.id;
    expect(owner("/")).toBe("core");
    expect(owner("/today")).toBe("core");
    expect(owner("/todayx")).toBeUndefined();
    expect(owner("/api/mydays")).toBeUndefined();
    expect(owner("/api/myday/templates")).toBe("routines");
    expect(owner("/api/books/backfill")).toBe("reading");
    expect(owner("/api/books/search")).toBe("reading");
    expect(owner("/api/covers/sample.jpg")).toBe("reading");
    expect(owner("/api/avatars/sample.jpg")).toBe("core");
    expect(owner("/api/photos/sample.jpg")).toBe("core");
    expect(owner("/api/settings")).toBe("core");
    expect(owner("/api/settings/parent")).toBe("core");
    expect(owner("/api/settings/modules")).toBe("core");
    expect(owner("/api/events")).toBe("calendar");
    expect(owner("/api/events/refresh")).toBe("calendar");
    expect(owner("/api/taskbox")).toBe("routines");
    expect(owner("/api/spark")).toBe("ask");
    expect(owner("/level-up")).toBe("progress");
    expect(owner("/_next/image")).toBeUndefined();
  });

  it("uses only skills.md manifest field names, apart from the marked v0-only fields", () => {
    const doc = fs.readFileSync(path.resolve(__dirname, "../docs/architecture/skills.md"), "utf8");
    const table = doc.split("## The manifest")[1].split("\n\n")[1];
    const documented = new Set<string>();
    for (const line of table.split("\n").slice(2)) {
      const first = line.split("|")[1] ?? "";
      for (const m of first.matchAll(/`([^`]+)`/g)) documented.add(m[1]);
    }
    expect(documented).toContain("sendsChildDataTo");
    const V0_ONLY = new Set(["core", "defaultEnabled", "dependsOn", "pages", "api", "tab"]);
    for (const m of ALL) {
      for (const key of Object.keys(m)) {
        if (V0_ONLY.has(key)) continue;
        if (key === "permissions") {
          for (const sub of Object.keys(m.permissions)) expect(documented).toContain(`permissions.${sub}`);
        } else {
          expect(documented).toContain(key);
        }
      }
    }
  });

  it("has sendsChildDataTo on every entry, and only Ask sends anything", () => {
    for (const m of ALL) {
      expect(Array.isArray(m.sendsChildDataTo)).toBe(true);
      if (m.id !== "ask") expect(m.sendsChildDataTo).toEqual([]);
    }
    expect(ALL.find((m) => m.id === "ask")?.sendsChildDataTo.length).toBeGreaterThan(0);
  });

  it("has exactly one core module, and Ask is the only one off on a fresh install", () => {
    expect(ALL.filter((m) => m.core).map((m) => m.id)).toEqual(["core"]);
    expect(Object.entries(defaultModuleState()).filter(([, on]) => !on)).toEqual([["ask", false]]);
    expect(TOGGLEABLE_MODULES).toHaveLength(8);
  });
});

describe("dependsOn rules", () => {
  const all = defaultModuleState();
  it("turning routines off turns rewards and progress off, and nothing else", () => {
    const next = applyModuleChanges(all, { routines: false });
    expect(next).toEqual({ ...all, routines: false, rewards: false, progress: false });
  });
  it("turning rewards or progress on turns routines back on", () => {
    const off = applyModuleChanges(all, { routines: false });
    expect(applyModuleChanges(off, { rewards: true })).toMatchObject({ routines: true, rewards: true, progress: false });
    expect(applyModuleChanges(off, { progress: true })).toMatchObject({ routines: true, rewards: false, progress: true });
  });
  it("reading does not depend on rewards", () => {
    expect(applyModuleChanges(all, { rewards: false, routines: false })).toMatchObject({ reading: true });
  });
  it("off wins when one change list asks for both, and core or unknown ids change nothing", () => {
    expect(applyModuleChanges(all, { routines: false, rewards: true })).toMatchObject({ routines: false, rewards: false });
    expect(applyModuleChanges(all, { core: false, nope: true })).toEqual(all);
  });
  it("repairs a stored state where a module is on but its dependency is off", () => {
    expect(applyModuleChanges({ ...all, routines: false, rewards: true }, {})).toMatchObject({ rewards: false });
  });
});
