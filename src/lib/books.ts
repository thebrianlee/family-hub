// Book search + cover caching.
//
// Search: Open Library primary, Google Books fallback. Covers: downloaded
// server-side into data/covers/ and served by /api/covers/[file] — NOT
// public/, because Next production only serves public/ files that existed at
// build time. ISBNs are stored for the future Beanstack digest.

import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";
import { getDb } from "./db";
import { coversDir } from "./paths";
import { safeGet, type SafeGetter } from "./safe-fetch";

export interface BookSearchResult {
  title: string;
  author: string | null;
  isbn: string | null;
  thumbnail: string | null;
  year: string | null;
}

/** Primary: Open Library (keyless, generous quota). Fallback: Google Books
 *  (keyless but shared anonymous quota — often exhausted). */
export async function searchBooks(query: string): Promise<BookSearchResult[]> {
  try {
    return await searchOpenLibrary(query);
  } catch (err) {
    console.error("[books] Open Library failed, trying Google Books:", String(err));
    return searchGoogleBooks(query);
  }
}

async function searchOpenLibrary(query: string): Promise<BookSearchResult[]> {
  const url =
    `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}` +
    `&limit=8&fields=title,author_name,first_publish_year,cover_i,isbn`;
  const res = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
    headers: { "User-Agent": "FamilyHub/1.0 (family wall display)" },
  });
  if (!res.ok) throw new Error(`Open Library HTTP ${res.status}`);
  const data = await res.json();
  const docs: {
    title?: string;
    author_name?: string[];
    first_publish_year?: number;
    cover_i?: number;
    isbn?: string[];
  }[] = data.docs ?? [];
  return docs.map((d) => ({
    title: d.title ?? "(untitled)",
    author: d.author_name?.[0] ?? null,
    isbn: d.isbn?.find((i) => i.length === 13) ?? d.isbn?.[0] ?? null,
    thumbnail: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : null,
    year: d.first_publish_year ? String(d.first_publish_year) : null,
  }));
}

async function searchGoogleBooks(query: string): Promise<BookSearchResult[]> {
  const url =
    `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}` +
    `&maxResults=8&printType=books&fields=items(volumeInfo(title,authors,industryIdentifiers,imageLinks,publishedDate))`;
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Google Books HTTP ${res.status}`);
  const data = await res.json();
  const items: Record<string, unknown>[] = data.items ?? [];
  return items.map((item) => {
    const v = (item.volumeInfo ?? {}) as {
      title?: string;
      authors?: string[];
      industryIdentifiers?: { type: string; identifier: string }[];
      imageLinks?: { thumbnail?: string; smallThumbnail?: string };
      publishedDate?: string;
    };
    const isbn13 = v.industryIdentifiers?.find((i) => i.type === "ISBN_13")?.identifier;
    const isbn10 = v.industryIdentifiers?.find((i) => i.type === "ISBN_10")?.identifier;
    const thumb = v.imageLinks?.thumbnail ?? v.imageLinks?.smallThumbnail ?? null;
    return {
      title: v.title ?? "(untitled)",
      author: v.authors?.[0] ?? null,
      isbn: isbn13 ?? isbn10 ?? null,
      thumbnail: thumb ? thumb.replace(/^http:/, "https:") : null,
      year: v.publishedDate?.slice(0, 4) ?? null,
    };
  });
}

/** Find and cache covers for books added before cover support (or manually). */
export async function backfillCovers(): Promise<{ filled: number; missed: number }> {
  const db = getDb();
  const bare = db
    .prepare("SELECT id, title, author FROM books WHERE cover_path IS NULL")
    .all() as { id: number; title: string; author: string | null }[];
  let filled = 0;
  let missed = 0;
  for (const b of bare) {
    try {
      const results = await searchBooks(b.author ? `${b.title} ${b.author}` : b.title);
      const hit = results.find((r) => r.thumbnail);
      if (hit?.thumbnail) {
        await cacheCover(b.id, hit.thumbnail);
        if (hit.isbn) db.prepare("UPDATE books SET isbn=COALESCE(isbn, ?) WHERE id=?").run(hit.isbn, b.id);
        filled++;
      } else {
        missed++;
      }
    } catch {
      missed++;
    }
  }
  return { filled, missed };
}

// Covers are only ever downloaded from the two search providers (and the
// archive.org storage Open Library redirects to). The URL can arrive from the
// browser, so anything else is refused before a request is made.
const COVER_HOSTS = [/^covers\.openlibrary\.org$/, /^([a-z0-9-]+\.)*archive\.org$/, /^books\.google\.com$/, /^books\.googleusercontent\.com$/];
const COVER_MAX_BYTES = 5 * 1024 * 1024;
const COVER_MAX_REDIRECTS = 3;

export function isAllowedCoverUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.port && COVER_HOSTS.some((re) => re.test(url.hostname.toLowerCase()));
  } catch {
    return false;
  }
}

/** `get` is injectable for tests; production always uses safeGet. */
export async function downloadCover(raw: string, get: SafeGetter = safeGet): Promise<Buffer> {
  let current = raw;
  for (let hop = 0; hop <= COVER_MAX_REDIRECTS; hop++) {
    if (!isAllowedCoverUrl(current)) throw new Error("cover host not allowed");
    const res = await get(current, { maxBytes: COVER_MAX_BYTES, timeoutMs: 15_000, accept: "image/*" });
    if (res.status >= 300 && res.status < 400 && res.location) {
      current = new URL(res.location, current).toString();
      continue;
    }
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    if (!res.contentType.toLowerCase().startsWith("image/")) throw new Error("not an image");
    // safeGet already stops reading past the cap; checked here too so the
    // limit holds whatever fetcher is passed in.
    if (res.body.length > COVER_MAX_BYTES) throw new Error("cover too large");
    if (res.body.length < 500) throw new Error("suspiciously small image");
    return res.body;
  }
  throw new Error("too many redirects");
}

/**
 * Download a cover image and attach it to a book row. Fire-and-forget safe.
 * The image is written to a new temp file in the covers folder ("wx": created
 * here, never an existing file or symlink) and renamed over the target, so
 * whatever sits at the target, a symlink included, is replaced rather than
 * written through. A local process with write access to the data folder is
 * out of scope (see readContained in paths.ts).
 */
export async function cacheCover(bookId: number, url: string): Promise<void> {
  try {
    const buf = await downloadCover(url);
    const dir = coversDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = `book-${bookId}.jpg`;
    const tmp = path.join(dir, `.${file}.${randomBytes(8).toString("hex")}.tmp`);
    try {
      fs.writeFileSync(tmp, buf, { flag: "wx" });
      fs.renameSync(tmp, path.join(dir, file));
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    getDb().prepare("UPDATE books SET cover_path=? WHERE id=?").run(`/api/covers/${file}`, bookId);
  } catch (err) {
    console.error(`[books] cover cache failed for book ${bookId}:`, String(err));
  }
}
