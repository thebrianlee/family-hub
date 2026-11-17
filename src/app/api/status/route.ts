import { isParent } from "@/lib/guard";
import { NextRequest, NextResponse } from "next/server";
import { setParentStatus } from "@/lib/queries";
import { PARENT_STATUSES, ParentStatus } from "@/lib/family";
import { isParentId } from "@/lib/household";

export const dynamic = "force-dynamic";

// { pin, member, status } — parent status chips, PIN-gated.
export async function POST(req: NextRequest) {
  const body = await req.json();
  if (!isParent(req, body)) {
    return NextResponse.json({ error: "Wrong PIN" }, { status: 403 });
  }
  if (
    !isParentId(body.member) ||
    !PARENT_STATUSES.includes(body.status as ParentStatus)
  ) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  setParentStatus(body.member, body.status);
  return NextResponse.json({ ok: true });
}
