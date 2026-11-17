import { NextRequest, NextResponse } from "next/server";
import { getReading, startBook, finishBook, saveBookNote, removeReadingBook } from "@/lib/queries";
import { cacheCover, isAllowedCoverUrl } from "@/lib/books";
import { getKids, isKidId } from "@/lib/household";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const kid = req.nextUrl.searchParams.get("kid");
  if (kid) {
    if (!isKidId(kid)) return NextResponse.json({ error: "Invalid kid" }, { status: 400 });
    return NextResponse.json({ summary: getReading(kid) });
  }
  return NextResponse.json({
    kids: Object.fromEntries(getKids().map((k) => [k.id, getReading(k.id)])),
  });
}

// action = "start"  { kid, title, author? }
// action = "finish" { kid, bookId }        — deposits the book_finish value
// action = "note"   { kid, bookId, prompt, answer }
export async function POST(req: NextRequest) {
  const body = await req.json();
  if (typeof body.kid !== "string" || !isKidId(body.kid)) {
    return NextResponse.json({ error: "Invalid kid" }, { status: 400 });
  }
  const kid = body.kid;

  switch (body.action) {
    case "start": {
      if (typeof body.title !== "string" || !body.title.trim()) {
        return NextResponse.json({ error: "Title required" }, { status: 400 });
      }
      const id = startBook(
        kid,
        body.title.trim(),
        typeof body.author === "string" ? body.author.trim() || null : null,
        typeof body.isbn === "string" ? body.isbn : null
      );
      if (typeof body.coverUrl === "string" && isAllowedCoverUrl(body.coverUrl)) {
        // Await (bounded) so the UI's refetch sees the cover immediately.
        await Promise.race([cacheCover(id, body.coverUrl), new Promise((r) => setTimeout(r, 8000))]);
      }
      return NextResponse.json({ ok: true, bookId: id });
    }
    case "remove": {
      const bookId = Number(body.bookId);
      if (!Number.isInteger(bookId)) return NextResponse.json({ error: "Invalid book" }, { status: 400 });
      const removed = removeReadingBook(kid, bookId);
      return NextResponse.json({ ok: removed });
    }
    case "finish": {
      const bookId = Number(body.bookId);
      if (!Number.isInteger(bookId)) return NextResponse.json({ error: "Invalid book" }, { status: 400 });
      const { earned } = finishBook(kid, bookId);
      return NextResponse.json({ ok: true, earned });
    }
    case "note": {
      const bookId = Number(body.bookId);
      if (!Number.isInteger(bookId) || typeof body.answer !== "string" || !body.answer.trim()) {
        return NextResponse.json({ error: "Answer required" }, { status: 400 });
      }
      saveBookNote(kid, bookId, typeof body.prompt === "string" ? body.prompt : "Tell me about it", body.answer.trim());
      return NextResponse.json({ ok: true });
    }
    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
}
