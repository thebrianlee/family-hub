import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

// The feed is served from memory and every fetch is counted.
const fetches = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/safe-fetch", () => ({
  safeGet: vi.fn(async () => {
    fetches.count++;
    const d = new Date(Date.now() + 2 * 86_400_000);
    const day = d.toISOString().slice(0, 10).replace(/-/g, "");
    const text = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a@test\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:${day}T150000Z\r\nDTEND:${day}T160000Z\r\nSUMMARY:Standup\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
    return { status: 200, contentType: "text/calendar", location: null, body: Buffer.from(text) };
  }),
}));

import { POST } from "@/app/api/events/refresh/route";
import { hashPin } from "@/lib/auth";
import { setSetting } from "@/lib/queries";
import { PARENT_COOKIE, signCookie } from "@/lib/session";

function refresh(parent = true) {
  const headers: Record<string, string> = { host: "hub.home", origin: "http://hub.home", "content-type": "application/json" };
  if (parent) headers.cookie = `${PARENT_COOKIE}=${signCookie("parent")}`;
  return POST(new NextRequest("http://hub.home/api/events/refresh", { method: "POST", headers, body: "{}" }));
}

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const h = hashPin("5938");
  setSetting("parent_pin", `${h.salt}:${h.hash}`);
  setSetting("ics_url_avery", "https://cal.example/avery.ics");
});

describe("manual calendar refresh", () => {
  it("needs a parent", async () => {
    expect((await refresh(false)).status).toBe(403);
    expect(fetches.count).toBe(0);
  });

  it("refetches at most once a minute, answering with the stored events in between", async () => {
    const first = await refresh();
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, events: 1, refreshed: true });
    expect(fetches.count).toBe(1);

    const second = await refresh();
    expect(await second.json()).toEqual({ ok: true, events: 1, refreshed: false });
    expect(fetches.count).toBe(1);

    // A minute later it fetches again.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    try {
      expect(await (await refresh()).json()).toEqual({ ok: true, events: 1, refreshed: true });
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
    expect(fetches.count).toBe(2);
  });
});
