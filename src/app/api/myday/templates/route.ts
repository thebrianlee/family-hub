import { NextRequest, NextResponse } from "next/server";
import { getTemplates, addTemplate, removeTemplate, addToTaskBox } from "@/lib/queries";
import { isKidId } from "@/lib/household";

export const dynamic = "force-dynamic";

// Checklist template editor. No PIN: the wall lives in the home, and routine
// edits are reversible; the PIN stays on money-adjacent things (stars, rewards).
export async function POST(req: NextRequest) {
  const body = await req.json();
  if (typeof body.kid !== "string" || !isKidId(body.kid)) {
    return NextResponse.json({ error: "Invalid kid" }, { status: 400 });
  }
  switch (body.action) {
    case "list":
      break;
    case "add": {
      const points = Number(body.points);
      const bucket = ["morning", "afternoon", "evening"].includes(body.bucket) ? body.bucket : "morning";
      if (
        typeof body.label !== "string" ||
        !body.label.trim() ||
        typeof body.emoji !== "string" ||
        !body.emoji.trim() ||
        !Number.isInteger(points) ||
        points < 0 ||
        points > 100
      ) {
        return NextResponse.json({ error: "Invalid item" }, { status: 400 });
      }
      const tracked = !!body.tracked;
      const label = body.label.trim();
      const days = typeof body.days === "string" && /^[0-6]{1,7}$/.test(body.days) ? body.days : "0123456";
      const type = body.type === "job" ? "job" : "routine";
      const dueDate = typeof body.due_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.due_date) ? body.due_date : null;
      addTemplate(body.kid, {
        label,
        emoji: body.emoji.trim(),
        points,
        bucket,
        tracked,
        unit: tracked ? (typeof body.unit === "string" && body.unit.trim() ? body.unit.trim() : "min") : null,
        metric_label: tracked ? (typeof body.metric_label === "string" && body.metric_label.trim() ? body.metric_label.trim() : label) : null,
        contribution: !!body.contribution,
        detailKind: body.detail_kind === "reading" || body.detail_kind === "levelup" ? body.detail_kind : null,
        days,
        type,
        dueDate,
      });
      if (body.saveToBox) addToTaskBox(label, body.emoji.trim(), bucket, tracked, type);
      break;
    }
    case "remove":
      if (!Number.isInteger(Number(body.id))) return NextResponse.json({ error: "Invalid" }, { status: 400 });
      removeTemplate(Number(body.id));
      break;
    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, templates: getTemplates(body.kid) });
}
