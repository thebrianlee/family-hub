import { NextRequest, NextResponse } from "next/server";
import { getEventsInRange } from "@/lib/calendar";
import { refreshIcsIfStale } from "@/lib/ics";
import { isEnabled } from "@/lib/modules";

export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  // A parent may still read the calendar while the module is off (Settings
  // shows what is kept), but that must not fetch the outside feeds.
  if (isEnabled("calendar")) refreshIcsIfStale();
  const from = req.nextUrl.searchParams.get("from") ?? "";
  const to = req.nextUrl.searchParams.get("to") ?? "";
  if (!DATE.test(from) || !DATE.test(to)) {
    return NextResponse.json({ error: "from and to are required (YYYY-MM-DD)" }, { status: 400 });
  }
  return NextResponse.json({ events: getEventsInRange(from, to) });
}
