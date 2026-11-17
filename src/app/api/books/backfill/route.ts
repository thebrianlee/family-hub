import { NextRequest, NextResponse } from "next/server";
import { isParent, parentRequired } from "@/lib/guard";
import { backfillCovers } from "@/lib/books";

export const dynamic = "force-dynamic";

// One-shot cover backfill for pre-existing/manual books. Parent-only: it
// makes one outbound search per book.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (!isParent(req, body)) return parentRequired();
  try {
    return NextResponse.json({ ok: true, ...(await backfillCovers()) });
  } catch (err) {
    console.error("[books] backfill failed:", String(err));
    return NextResponse.json({ error: "Backfill failed" }, { status: 500 });
  }
}
