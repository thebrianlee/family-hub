import { NextRequest, NextResponse } from "next/server";
import { getEventsInRange } from "@/lib/calendar";
import { refreshIcsIfStale } from "@/lib/ics";

export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  refreshIcsIfStale();
  const from = req.nextUrl.searchParams.get("from") ?? "";
  const to = req.nextUrl.searchParams.get("to") ?? "";
  if (!DATE.test(from) || !DATE.test(to)) {
    return NextResponse.json({ error: "from and to are required (YYYY-MM-DD)" }, { status: 400 });
  }
  return NextResponse.json({ events: getEventsInRange(from, to) });
}
