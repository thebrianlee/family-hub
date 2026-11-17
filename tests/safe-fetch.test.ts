import dns from "node:dns";
import { afterEach, describe, expect, it, vi } from "vitest";

import { guardedLookup, isPublicAddress, safeGet } from "@/lib/safe-fetch";

describe("isPublicAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a00:1",
    "fe80::1",
    "fe90::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "2002:7f00:1::",
    "64:ff9b::7f00:1",
  ])("blocks %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each(["8.8.8.8", "1.1.1.1", "142.250.72.14", "2607:f8b0:4005:80a::200e", "2606:4700:4700::1111"])(
    "allows %s",
    (ip) => {
      expect(isPublicAddress(ip)).toBe(true);
    }
  );

  it("rejects non-IP strings", () => {
    expect(isPublicAddress("example.com")).toBe(false);
  });
});

describe("isPublicAddress: IPv6 ranges that can hide a private target", () => {
  it.each([
    ["::7f00:1", "IPv4-compatible 127.0.0.1"],
    ["::a00:1", "IPv4-compatible 10.0.0.1"],
    ["::c0a8:101", "IPv4-compatible 192.168.1.1"],
    ["::8.8.8.8", "IPv4-compatible, deprecated even for a public IPv4"],
    ["64:ff9b:1::a00:1", "local-use NAT64"],
    ["64:ff9b:1:ffff::1", "local-use NAT64, top of the /48"],
    ["2001::1", "Teredo"],
    ["2001:0:4136:e378:8000:63bf:3fff:fdd2", "Teredo"],
    ["2001:2::1", "benchmarking"],
    ["2001:10::1", "ORCHID"],
    ["2001:20::1", "ORCHIDv2"],
    ["2001:1ff:ffff::1", "top of 2001::/23"],
  ])("blocks %s (%s)", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each([
    ["2001:200::1", "first block after 2001::/23"],
    ["2001:4860:4860::8888", "public resolver"],
    ["64:ff9b:2::1", "outside both NAT64 prefixes"],
    ["::1:0:0:1", "outside ::/96"],
  ])("allows %s (%s)", (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it("still allows public IPv4 (the ::/96 rule lives in the IPv6-only list)", () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("0.0.0.8")).toBe(false);
  });
});

describe("connect-time DNS check", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function fakeDns(addresses: dns.LookupAddress[]) {
    return vi.spyOn(dns, "lookup").mockImplementation(((
      _host: string,
      _opts: unknown,
      cb: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void
    ) => cb(null, addresses)) as unknown as typeof dns.lookup);
  }

  it("refuses a hostname that resolves to a private address", async () => {
    const lookup = fakeDns([{ address: "10.0.0.7", family: 4 }]);
    await expect(
      safeGet("https://calendar.example.com/feed.ics", { maxBytes: 1000, timeoutMs: 2000 })
    ).rejects.toThrow(/private network/);
    // The hostname passed the URL checks; the refusal came from the socket's own lookup.
    expect(lookup).toHaveBeenCalledWith("calendar.example.com", expect.objectContaining({ all: true }), expect.any(Function));
  });

  it("refuses when any one of the addresses is private", async () => {
    fakeDns([
      { address: "93.184.216.34", family: 4 },
      { address: "::1", family: 6 },
    ]);
    await expect(
      safeGet("https://mixed.example.com/feed.ics", { maxBytes: 1000, timeoutMs: 2000 })
    ).rejects.toThrow(/private network/);
  });

  it("hands public addresses to the socket in the shape it asked for", async () => {
    fakeDns([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);
    const one = await new Promise<unknown[]>((resolve) =>
      guardedLookup("example.com", {}, (...args) => resolve(args))
    );
    expect(one).toEqual([null, "93.184.216.34", 4]);
    const all = await new Promise<unknown[]>((resolve) =>
      guardedLookup("example.com", { all: true }, (...args) => resolve(args))
    );
    expect(all).toEqual([
      null,
      [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      ],
    ]);
  });

  it("refuses an empty answer", async () => {
    fakeDns([]);
    const [err] = await new Promise<unknown[]>((resolve) =>
      guardedLookup("nothing.example.com", {}, (...args) => resolve(args))
    );
    expect(String(err)).toMatch(/private network/);
  });
});

describe("safeGet refuses before connecting", () => {
  it.each([
    ["https://127.0.0.1/x", /private/],
    ["https://[::ffff:127.0.0.1]/x", /private/],
    ["https://[::1]/x", /private/],
    ["https://localhost/x", /public/],
    ["https://printer.local/x", /public/],
    ["http://example.com/x", /https/],
    ["ftp://example.com/x", /https/],
    ["https://user:pw@example.com/x", /username/],
    ["not a url", /valid/],
  ])("%s", async (url, message) => {
    await expect(safeGet(url, { maxBytes: 1000, timeoutMs: 1000 })).rejects.toThrow(message);
  });
});
