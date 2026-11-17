import { describe, expect, it } from "vitest";

import { config, sameOrigin } from "@/proxy";
import { NextRequest } from "next/server";

// The proxy must run for the image optimizer too: /_next/image can fetch
// /api/photos/... internally, so excluding it would serve photos to a locked
// screen.
function matches(path: string): boolean {
  return config.matcher.some((m: string) => new RegExp(`^${m}$`).test(path));
}

describe("proxy coverage", () => {
  it("covers pages, API routes and the image optimizer", () => {
    for (const p of ["/today", "/api/photos/a.jpg", "/_next/image", "/unlock"]) expect(matches(p)).toBe(true);
  });
  it("skips only static build assets and public demo avatars", () => {
    for (const p of ["/_next/static/chunks/x.js", "/favicon.ico", "/demo-avatars/a.svg"]) expect(matches(p)).toBe(false);
  });
});

describe("same-origin check behind proxies", () => {
  const req = (h: Record<string, string>) =>
    new NextRequest("http://hub.home/api/lists", { method: "POST", headers: h });
  it("uses the first X-Forwarded-Host entry", () => {
    expect(sameOrigin(req({ origin: "https://hub.example", "x-forwarded-host": "hub.example, internal:3847", host: "internal:3847" }))).toBe(true);
    expect(sameOrigin(req({ origin: "https://evil.example", "x-forwarded-host": "hub.example, internal:3847" }))).toBe(false);
  });
});
