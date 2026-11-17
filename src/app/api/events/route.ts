import { NextRequest, NextResponse } from "next/server";
import { isParent, parentRequired } from "@/lib/guard";
import { addWallEvent, deleteWallEvent } from "@/lib/queries";
import { isMemberId } from "@/lib/household";

export const dynamic = "force-dynamic";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// POST { action:"add", members[], title, date, start?, end?, location? }
//      { action:"delete", id }
export async function POST(req: NextRequest) {
  const b = await req.json();

  if (b.action === "delete") {
    // Anyone at the screen can add an event; removing one is a parent action.
    if (!isParent(req, b)) return parentRequired();
    if (!Number.isInteger(Number(b.id))) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
    deleteWallEvent(Number(b.id));
    return NextResponse.json({ ok: true });
  }

  const requested: unknown[] = Array.isArray(b.members) ? b.members : [];
  if (!requested.every((m) => isMemberId(m))) {
    return NextResponse.json({ error: "Unknown family member" }, { status: 400 });
  }
  const members = [...new Set(requested as string[])];
  const title = typeof b.title === "string" ? b.title.trim() : "";
  const date = typeof b.date === "string" ? b.date : "";
  const start = typeof b.start === "string" && HHMM.test(b.start) ? b.start : null;
  const end = typeof b.end === "string" && HHMM.test(b.end) ? b.end : null;
  const location = typeof b.location === "string" && b.location.trim() ? b.location.trim().slice(0, 120) : null;

  if (!members.length || !title || !DATE.test(date)) {
    return NextResponse.json({ error: "Pick who, a title, and a date" }, { status: 400 });
  }
  addWallEvent(members, title, date, start, end, location, b.countdown === true);
  return NextResponse.json({ ok: true });
}
