import { NextRequest, NextResponse } from "next/server";
import { getKidDay, getKidWeek, tickChecklist, setMood, getMood } from "@/lib/queries";
import { getKids, isKidId } from "@/lib/household";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const kid = req.nextUrl.searchParams.get("kid");
  if (req.nextUrl.searchParams.get("week")) {
    return NextResponse.json({ weeks: getKids().map((k) => getKidWeek(k.id)) });
  }
  if (kid) {
    if (!isKidId(kid)) return NextResponse.json({ error: "Invalid kid" }, { status: 400 });
    return NextResponse.json({ day: getKidDay(kid) });
  }
  // No kid → every kid's day (all-kids-visible My Day).
  return NextResponse.json({ days: getKids().map((k) => getKidDay(k.id)) });
}

// POST: tick an item { kid, templateId, amount? } | set mood { action:"mood", kid, mood }
export async function POST(req: NextRequest) {
  const body = await req.json();
  if (typeof body.kid !== "string" || !isKidId(body.kid)) {
    return NextResponse.json({ error: "Invalid kid" }, { status: 400 });
  }

  if (body.action === "mood") {
    if (typeof body.mood !== "string") return NextResponse.json({ error: "Invalid mood" }, { status: 400 });
    setMood(body.kid, body.mood);
    return NextResponse.json({ ok: true, mood: getMood(body.kid) });
  }

  if (!Number.isInteger(Number(body.templateId))) {
    return NextResponse.json({ error: "Invalid" }, { status: 400 });
  }
  const amount = body.amount == null ? null : Number(body.amount);
  const result = tickChecklist(body.kid, Number(body.templateId), amount);
  if (!result.ok) return NextResponse.json({ error: "Unknown item" }, { status: 400 });
  return NextResponse.json(result);
}
