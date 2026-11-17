import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { downloadCover, isAllowedCoverUrl } from "@/lib/books";
import { coversDir, dataDir, photoDir, readContained } from "@/lib/paths";
import { SafeFetchError, type SafeGetOptions, type SafeResponse } from "@/lib/safe-fetch";

describe("data paths", () => {
  it("resolves DATA_DIR to an absolute folder", () => {
    expect(path.isAbsolute(dataDir())).toBe(true);
    expect(coversDir()).toBe(path.join(dataDir(), "covers"));
  });

  it("uses PHOTO_DIR when set, else DATA_DIR/photos", () => {
    expect(photoDir()).toBe(path.join(dataDir(), "photos"));
    process.env.PHOTO_DIR = "/photos";
    expect(photoDir()).toBe("/photos");
    delete process.env.PHOTO_DIR;
  });
});

describe("readContained", () => {
  it("reads a regular file and refuses a symlink that leaves the folder", () => {
    const base = path.join(dataDir(), "photos");
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, "ok.jpg"), "inside");
    const outside = path.join(dataDir(), "secret.txt");
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(outside, path.join(base, "escape.jpg"));

    expect(readContained(base, "ok.jpg")?.toString()).toBe("inside");
    expect(readContained(base, "escape.jpg")).toBeNull();
    expect(readContained(base, "missing.jpg")).toBeNull();
  });
});

describe("isAllowedCoverUrl", () => {
  it.each([
    "https://covers.openlibrary.org/b/id/123-L.jpg",
    "https://ia800100.us.archive.org/view_archive.php?archive=x",
    "https://books.google.com/books/content?id=abc&img=1",
  ])("allows %s", (url) => expect(isAllowedCoverUrl(url)).toBe(true));

  it.each([
    "http://covers.openlibrary.org/b/id/123-L.jpg",
    "https://covers.openlibrary.org:8443/b/id/123-L.jpg",
    "https://192.168.1.1/admin",
    "https://evil.example/archive.org",
    "https://archive.org.evil.example/x",
    "not a url",
  ])("refuses %s", (url) => expect(isAllowedCoverUrl(url)).toBe(false));
});

describe("downloadCover", () => {
  const COVER = "https://covers.openlibrary.org/b/id/123-L.jpg";
  const IMAGE = Buffer.alloc(4096, 0xff);
  const FIVE_MB = 5 * 1024 * 1024;

  function response(partial: Partial<SafeResponse>): SafeResponse {
    return { status: 200, contentType: "image/jpeg", location: null, body: IMAGE, ...partial };
  }

  /** Stand-in for safeGet: answers from a table and records every request. */
  function scripted(table: Record<string, SafeResponse | Error>) {
    const calls: { url: string; opts: SafeGetOptions }[] = [];
    const get = async (url: string, opts: SafeGetOptions) => {
      calls.push({ url, opts });
      const r = table[url];
      if (!r) throw new Error(`unexpected request to ${url}`);
      if (r instanceof Error) throw r;
      return r;
    };
    return { get, calls };
  }

  it("follows a redirect to archive.org and returns the image", async () => {
    const { get, calls } = scripted({
      [COVER]: response({ status: 302, location: "https://ia800100.us.archive.org/view_archive.php?x=1" }),
      "https://ia800100.us.archive.org/view_archive.php?x=1": response({}),
    });
    await expect(downloadCover(COVER, get)).resolves.toEqual(IMAGE);
    expect(calls.map((c) => c.url)).toEqual([COVER, "https://ia800100.us.archive.org/view_archive.php?x=1"]);
    for (const c of calls) expect(c.opts.maxBytes).toBe(FIVE_MB);
  });

  it.each([
    ["another host", "https://evil.example/cover.jpg"],
    ["a LAN address", "https://192.168.1.10/cover.jpg"],
    ["plain http on an allowed host", "http://covers.openlibrary.org/b/id/1.jpg"],
    ["a look-alike host", "https://archive.org.evil.example/x.jpg"],
  ])("refuses a redirect to %s without requesting it", async (_label, target) => {
    const { get, calls } = scripted({ [COVER]: response({ status: 302, location: target }) });
    await expect(downloadCover(COVER, get)).rejects.toThrow(/cover host not allowed/);
    expect(calls.map((c) => c.url)).toEqual([COVER]);
  });

  it.each(["text/html", "application/octet-stream", ""])("refuses a %j content type", async (type) => {
    const { get } = scripted({ [COVER]: response({ contentType: type }) });
    await expect(downloadCover(COVER, get)).rejects.toThrow(/not an image/);
  });

  it("refuses a body over 5 MB", async () => {
    const { get } = scripted({ [COVER]: response({ body: Buffer.alloc(FIVE_MB + 1) }) });
    await expect(downloadCover(COVER, get)).rejects.toThrow(/too large/);
  });

  it("passes on safeGet's own refusal of an oversized stream", async () => {
    const { get } = scripted({ [COVER]: new SafeFetchError("Response is too large") });
    await expect(downloadCover(COVER, get)).rejects.toThrow(/Response is too large/);
  });

  it("stops after three redirects", async () => {
    const hop = (i: number) => `https://covers.openlibrary.org/b/id/${i}.jpg`;
    const table: Record<string, SafeResponse> = {};
    for (let i = 0; i < 5; i++) table[hop(i)] = response({ status: 302, location: hop(i + 1) });
    const { get, calls } = scripted(table);
    await expect(downloadCover(hop(0), get)).rejects.toThrow(/too many redirects/);
    expect(calls).toHaveLength(4);
  });
});
