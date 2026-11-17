import { isParent } from "@/lib/guard";
import { NextRequest, NextResponse } from "next/server";
import { getLevelUp, logLevelUp, getActivities, addActivity, removeActivity } from "@/lib/queries";
import { getKids, isKidId } from "@/lib/household";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const kid = req.nextUrl.searchParams.get("kid");
  if (kid) {
    if (!isKidId(kid)) return NextResponse.json({ error: "Invalid kid" }, { status: 400 });
    return NextResponse.json({ summary: getLevelUp(kid) });
  }
  return NextResponse.json({
    kids: Object.fromEntries(getKids().map((k) => [k.id, getLevelUp(k.id)])),
  });
}

// default            { kid, activity, duration_min?, count? }  — log a session
// action=add_activity    { kid, label, emoji, metric }             — kid-added, no PIN
// action=remove_activity { kid, slug, pin }                        — PIN (protects history view)
export async function POST(req: NextRequest) {
  const body = await req.json();
  if (typeof body.kid !== "string" || !isKidId(body.kid)) {
    return NextResponse.json({ error: "Invalid kid" }, { status: 400 });
  }

  if (body.action === "add_activity") {
    if (
      typeof body.label !== "string" ||
      !body.label.trim() ||
      typeof body.emoji !== "string" ||
      (body.metric !== "count" && body.metric !== "duration")
    ) {
      return NextResponse.json({ error: "Invalid activity" }, { status: 400 });
    }
    const res = addActivity(body.kid, body.label.trim(), body.emoji, body.metric);
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
    return NextResponse.json({ ok: true, summary: getLevelUp(body.kid) });
  }

  if (body.action === "remove_activity") {
    if (!isParent(req, body)) {
      return NextResponse.json({ error: "Wrong PIN" }, { status: 403 });
    }
    if (typeof body.slug !== "string") return NextResponse.json({ error: "Invalid" }, { status: 400 });
    removeActivity(body.kid, body.slug);
    return NextResponse.json({ ok: true, summary: getLevelUp(body.kid) });
  }

  const def = getActivities(body.kid).find((a) => a.slug === body.activity);
  if (!def) return NextResponse.json({ error: "Invalid activity" }, { status: 400 });
  const duration = body.duration_min == null ? null : Number(body.duration_min);
  const count = body.count == null ? null : Number(body.count);
  const inRange = (v: number | null) => v === null || (Number.isFinite(v) && v > 0 && v <= 100000);
  if (!inRange(duration) || !inRange(count)) {
    return NextResponse.json({ error: "Invalid values" }, { status: 400 });
  }
  if (def.metric === "count" && count === null) {
    return NextResponse.json({ error: `${def.label} needs a count` }, { status: 400 });
  }
  if (def.metric === "duration" && duration === null) {
    return NextResponse.json({ error: `${def.label} needs a duration` }, { status: 400 });
  }
  const result = logLevelUp(body.kid, body.activity, duration, count);
  return NextResponse.json({ ok: true, ...result });
}
