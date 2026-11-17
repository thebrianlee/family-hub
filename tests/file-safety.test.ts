import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Cover downloads are answered from memory: a valid-looking JPEG body.
const IMAGE = vi.hoisted(() => Buffer.alloc(4096, 0xd8));
vi.mock("@/lib/safe-fetch", () => ({
  safeGet: vi.fn(async () => ({ status: 200, contentType: "image/jpeg", location: null, body: IMAGE })),
}));

import { cacheCover } from "@/lib/books";
import { getDb } from "@/lib/db";
import { coversDir, dataDir, photoDir, readContained } from "@/lib/paths";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cover cache writes", () => {
  it("replace a symlink planted at the cover path instead of writing through it", async () => {
    const bookId = Number(
      getDb().prepare("INSERT INTO books (kid, title) VALUES ('riley', 'Planted')").run().lastInsertRowid
    );
    const outside = path.join(dataDir(), "outside-target.txt");
    fs.writeFileSync(outside, "do not overwrite");
    fs.mkdirSync(coversDir(), { recursive: true });
    const target = path.join(coversDir(), `book-${bookId}.jpg`);
    fs.symlinkSync(outside, target);

    await cacheCover(bookId, "https://covers.openlibrary.org/b/id/1-L.jpg");

    expect(fs.readFileSync(outside, "utf8")).toBe("do not overwrite");
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(target)).toEqual(IMAGE);
    expect(getDb().prepare("SELECT cover_path FROM books WHERE id=?").get(bookId)).toEqual({
      cover_path: `/api/covers/book-${bookId}.jpg`,
    });
    // No temp file is left behind.
    expect(fs.readdirSync(coversDir()).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("contained reads", () => {
  it("refuse a photo that is a symlink at the moment it is opened", () => {
    const base = photoDir();
    fs.mkdirSync(base, { recursive: true });
    const outside = path.join(dataDir(), "private.txt");
    fs.writeFileSync(outside, "private");
    const leaf = path.join(base, "swapped.jpg");
    fs.symlinkSync(outside, leaf);

    // The folder check saw a regular file (as if the swap came right after it).
    const realpath = fs.realpathSync;
    const realBase = realpath(base);
    vi.spyOn(fs, "realpathSync").mockImplementation(((p: fs.PathLike) =>
      p === leaf ? path.join(realBase, "swapped.jpg") : realpath(p)) as typeof fs.realpathSync);

    expect(readContained(base, "swapped.jpg")).toBeNull();
  });

  it("still read a regular photo", () => {
    const base = photoDir();
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, "beach.jpg"), "pixels");
    expect(readContained(base, "beach.jpg")?.toString()).toBe("pixels");
    expect(readContained(base, ".")).toBeNull();
  });
});
