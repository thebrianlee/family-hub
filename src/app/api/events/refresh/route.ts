import { NextRequest, NextResponse } from "next/server";
import { isParent, parentRequired } from "@/lib/guard";
import { refreshIcsManual } from "@/lib/ics";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

// Manual trigger for the iCal refresh. Parent-only: it makes outbound requests.
// A refresh that finished less than a minute ago is not repeated; the stored
// events are returned instead (refreshed: false).
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (!isParent(req, body)) return parentRequired();
  try {
    const { refreshed } = await refreshIcsManual();
    const count = (getDb().prepare("SELECT COUNT(*) c FROM synced_events").get() as { c: number }).c;
    return NextResponse.json({ ok: true, events: count, refreshed });
  } catch (err) {
    console.error("[ics] manual refresh failed:", String(err));
    return NextResponse.json({ error: "Refresh failed" }, { status: 500 });
  }
}
