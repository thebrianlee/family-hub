import { isParent } from "@/lib/guard";
import { NextRequest, NextResponse } from "next/server";
import { getRules, addRule, updateRule, deleteRule } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ rules: getRules() });
}

// Parent-editable family rules. { pin, action, ... }
export async function POST(req: NextRequest) {
  const body = await req.json();
  if (!isParent(req, body)) {
    return NextResponse.json({ error: "Wrong PIN" }, { status: 403 });
  }
  switch (body.action) {
    case "add":
      if (typeof body.text !== "string" || !body.text.trim()) {
        return NextResponse.json({ error: "Invalid" }, { status: 400 });
      }
      addRule(body.text.trim());
      break;
    case "update":
      if (!Number.isInteger(Number(body.id)) || typeof body.text !== "string" || !body.text.trim()) {
        return NextResponse.json({ error: "Invalid" }, { status: 400 });
      }
      updateRule(Number(body.id), body.text.trim());
      break;
    case "delete":
      if (!Number.isInteger(Number(body.id))) return NextResponse.json({ error: "Invalid" }, { status: 400 });
      deleteRule(Number(body.id));
      break;
    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, rules: getRules() });
}
