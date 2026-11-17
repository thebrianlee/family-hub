import { isParent } from "@/lib/guard";
import { NextRequest, NextResponse } from "next/server";
import { getSetting, setSetting } from "@/lib/queries";

export const dynamic = "force-dynamic";

const PUBLIC_KEYS = [
  "currency_name",
  "sleep_start",
  "sleep_end",
  "screensaver_idle_min",
  "family_goal_label",
  "family_goal_emoji",
  "family_goal_target",
  "kid_jar_target",
];

export async function GET() {
  return NextResponse.json(Object.fromEntries(PUBLIC_KEYS.map((k) => [k, getSetting(k)])));
}

// { pin, key, value } — parent-editable settings (never the PIN itself here).
export async function POST(req: NextRequest) {
  const body = await req.json();
  if (!isParent(req, body)) {
    return NextResponse.json({ error: "Wrong PIN" }, { status: 403 });
  }
  if (!PUBLIC_KEYS.includes(body.key) || typeof body.value !== "string") {
    return NextResponse.json({ error: "Invalid key" }, { status: 400 });
  }
  setSetting(body.key, body.value);
  return NextResponse.json({ ok: true });
}
