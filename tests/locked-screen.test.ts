import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyAmbient, type AmbientConfig } from "@/components/Ambient";
import { hashPin } from "@/lib/auth";
import { getMembers } from "@/lib/household";
import { setSetting } from "@/lib/queries";
import { DEVICE_COOKIE, PARENT_COOKIE, screenUnlocked, signCookie } from "@/lib/session";

// A screen that has not entered the parent PIN may only see the unlock page.
// The proxy refuses household API reads; these tests cover the rest of the
// locked path: the page shell itself and the screensaver.

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined) }),
}));
vi.mock("next/font/local", () => ({ default: () => ({ variable: "font" }) }));

const { default: RootLayout } = await import("@/app/layout");

/** Every prop value in a React element tree, so a test can look for data that
 *  would be sent to the browser even if nothing renders it. */
function hasProp(node: ReactNode, key: string): boolean {
  if (Array.isArray(node)) return node.some((n) => hasProp(n, key));
  if (!isValidElement(node)) return false;
  const props = node.props as Record<string, unknown>;
  if (key in props) return true;
  return hasProp(props.children as ReactNode, key);
}

beforeEach(() => {
  jar.clear();
  setSetting("setup_complete", "1");
  // Cookies are bound to the stored PIN (authVersion), so a household needs one.
  const h = hashPin("5938");
  setSetting("parent_pin", `${h.salt}:${h.hash}`);
  process.env.REQUIRE_AUTH_FOR_READS = "1";
});

afterEach(() => {
  delete process.env.REQUIRE_AUTH_FOR_READS;
});

describe("screenUnlocked", () => {
  const read = (cookies: Record<string, string>) => (name: string) => cookies[name];

  it("is false for a locked screen with no cookie or a forged one", () => {
    expect(screenUnlocked(read({}))).toBe(false);
    expect(screenUnlocked(read({ [DEVICE_COOKIE]: signCookie("device") + "x" }))).toBe(false);
    expect(screenUnlocked(read({ [DEVICE_COOKIE]: signCookie("parent") }))).toBe(false);
  });

  it("is true with a device or parent cookie, or when reads are not locked", () => {
    expect(screenUnlocked(read({ [DEVICE_COOKIE]: signCookie("device") }))).toBe(true);
    expect(screenUnlocked(read({ [PARENT_COOKIE]: signCookie("parent") }))).toBe(true);
    process.env.REQUIRE_AUTH_FOR_READS = "0";
    expect(screenUnlocked(read({}))).toBe(true);
  });
});

describe("root layout on a locked screen", () => {
  it("sends no household data, screensaver or tab bar", async () => {
    const names = getMembers().map((m) => m.name);
    expect(names.length).toBeGreaterThan(0);

    const tree = await RootLayout({ children: createElement("p", null, "unlock page") });
    expect(hasProp(tree, "members")).toBe(false);
    expect(hasProp(tree, "enabled")).toBe(false);
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("unlock page");
    expect(html).not.toContain("member-colors");
    for (const name of names) expect(html).not.toContain(name);
  });

  it("gives an unlocked screen the full app", async () => {
    jar.set(DEVICE_COOKIE, signCookie("device"));
    const tree = await RootLayout({ children: createElement("p", null, "today") });
    expect(hasProp(tree, "members")).toBe(true);
  });
});

describe("applyAmbient", () => {
  const settings: AmbientConfig = { photos: ["/p/1.jpg"], art: [], quotes: [], idleMinutes: 10, sleepStart: "21:30", sleepEnd: "06:00" };

  it("uses fresh settings", () => {
    const setCfg = vi.fn();
    const setSaver = vi.fn();
    applyAmbient({ cfg: settings, locked: false }, setCfg, setSaver);
    expect(setCfg).toHaveBeenCalledWith(settings);
    expect(setSaver).not.toHaveBeenCalled();
  });

  it("drops settings loaded earlier and leaves the screensaver when the screen is locked", () => {
    const setCfg = vi.fn();
    const setSaver = vi.fn();
    applyAmbient({ cfg: null, locked: true }, setCfg, setSaver);
    expect(setCfg).toHaveBeenCalledWith(null);
    expect(setSaver).toHaveBeenCalledWith(false);
  });

  it("keeps what it had after a network error", () => {
    const setCfg = vi.fn();
    const setSaver = vi.fn();
    applyAmbient({ cfg: null, locked: false }, setCfg, setSaver);
    expect(setCfg).not.toHaveBeenCalled();
    expect(setSaver).not.toHaveBeenCalled();
  });
});
