import { NextRequest, NextResponse } from "next/server";
import { searchBooks } from "@/lib/books";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q || q.length < 2) return NextResponse.json({ results: [] });
  try {
    return NextResponse.json({ results: await searchBooks(q) });
  } catch (err) {
    return NextResponse.json({ results: [], error: String(err) }, { status: 502 });
  }
}
