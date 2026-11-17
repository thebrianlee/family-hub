import { NextRequest, NextResponse } from "next/server";
import { getProgress } from "@/lib/queries";
import { getKids, isKidId } from "@/lib/household";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const kid = req.nextUrl.searchParams.get("kid");
  if (!kid) {
    // All kids — powers the all-kids Rewards columns.
    return NextResponse.json({ all: getKids().map((k) => getProgress(k.id)) });
  }
  if (!isKidId(kid)) return NextResponse.json({ error: "Invalid kid" }, { status: 400 });
  return NextResponse.json({ progress: getProgress(kid) });
}
