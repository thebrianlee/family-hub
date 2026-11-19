import { NextRequest, NextResponse } from "next/server";
import { searchBooks } from "@/lib/books";
import { ModuleOffError } from "@/lib/module-fetch";
import { isEnabled } from "@/lib/modules";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // The proxy lets a parent's reads through while Reading is off; a search
  // would still call the book sites, so it is refused here.
  if (!isEnabled("reading")) return NextResponse.json({ error: "module_off" }, { status: 404 });
  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q || q.length < 2) return NextResponse.json({ results: [] });
  try {
    return NextResponse.json({ results: await searchBooks(q) });
  } catch (err) {
    // Reading was switched off while the search ran: no fallback was tried.
    if (err instanceof ModuleOffError) return NextResponse.json({ error: "module_off" }, { status: 404 });
    return NextResponse.json({ results: [], error: String(err) }, { status: 502 });
  }
}
