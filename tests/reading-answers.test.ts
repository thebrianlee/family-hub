import { describe, expect, it } from "vitest";

import { answerGate } from "@/lib/answer-gate";
import { coverPreviewSrc } from "@/lib/cover-preview";
import { getDb } from "@/lib/db";
import { getReading, localCoverPath } from "@/lib/queries";

// The Reading sheet and page drop answers that belong to an earlier open,
// another kid or an overtaken request, and the browser only ever loads covers
// from the hub.

describe("answerGate (ReadingSheet and the Reading page)", () => {
  it("drops an answer from an earlier open of the sheet for the same kid", () => {
    const gate = answerGate();
    gate.reset("riley:7"); // opened for Riley's Reading routine
    const first = gate.take("riley:7");
    gate.reset(""); // closed
    gate.reset("riley:7"); // opened again
    const second = gate.take("riley:7");
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
  });

  it("drops an answer for another kid, and a stale request for that kid does not stale the current one", () => {
    const gate = answerGate();
    gate.reset("riley:7");
    const riley = gate.take("riley:7");
    gate.reset("quinn:9"); // switched to Quinn
    const quinn = gate.take("quinn:9");
    // A finish for Riley that resolves now calls load with Riley's closure.
    const late = gate.take("riley:7");
    expect(gate.isCurrent(riley)).toBe(false);
    expect(gate.isCurrent(late)).toBe(false);
    expect(gate.isCurrent(quinn)).toBe(true);
  });

  it("a newer request overtakes an older one for the same open", () => {
    const gate = answerGate();
    gate.reset("riley:7");
    const older = gate.take("riley:7");
    const newer = gate.take("riley:7");
    expect(gate.isCurrent(older)).toBe(false);
    expect(gate.isCurrent(newer)).toBe(true);
  });

  it("nothing is current while the sheet is closed", () => {
    const gate = answerGate();
    gate.reset("riley:7");
    const open = gate.take("riley:7");
    gate.reset("");
    expect(gate.isCurrent(open)).toBe(false);
  });
});

describe("covers the browser loads", () => {
  it("a search result's thumbnail is loaded through the hub, never from the book site", () => {
    const src = coverPreviewSrc("https://covers.openlibrary.org/b/id/8675309-L.jpg?x=1&y=2");
    expect(src.startsWith("/api/books/thumb?url=")).toBe(true);
    expect(new URLSearchParams(src.split("?")[1]).get("url")).toBe("https://covers.openlibrary.org/b/id/8675309-L.jpg?x=1&y=2");
  });

  it("only a cover cached on the hub reaches a screen", () => {
    expect(localCoverPath("/api/covers/book-12.jpg")).toBe("/api/covers/book-12.jpg");
    for (const value of [
      "https://covers.openlibrary.org/b/id/8675309-L.jpg",
      "//covers.openlibrary.org/b/id/1-L.jpg",
      "/api/covers/../photos/a.jpg",
      "/api/covers/book-12.jpg?x",
      null,
      42,
    ]) {
      expect(localCoverPath(value)).toBeNull();
    }
  });

  it("getReading leaves out a cover path that is not a hub cover (an edited or restored database)", () => {
    const db = getDb();
    db.prepare("DELETE FROM books").run();
    const kid = (db.prepare("SELECT id FROM members WHERE role='kid' LIMIT 1").get() as { id: string }).id;
    const add = (title: string, cover: string, status: string) =>
      db
        .prepare(
          "INSERT INTO books (kid, title, cover_path, status, finished_at) VALUES (?, ?, ?, ?, CASE WHEN ? = 'finished' THEN datetime('now') END)"
        )
        .run(kid, title, cover, status, status);
    add("Owl Moon", "https://covers.openlibrary.org/b/id/1-L.jpg", "reading");
    add("Frog and Toad", "/api/covers/book-2.jpg", "reading");
    add("The Snowy Day", "https://books.google.com/books/content?id=sample", "finished");
    const r = getReading(kid);
    expect(r.reading.map((b) => [b.title, b.cover_path])).toEqual([
      ["Frog and Toad", "/api/covers/book-2.jpg"],
      ["Owl Moon", null],
    ]);
    expect(r.shelf.map((b) => b.cover_path)).toEqual([null]);
  });
});
