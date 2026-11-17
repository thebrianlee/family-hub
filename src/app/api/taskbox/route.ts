import { NextResponse } from "next/server";
import { getTaskBox } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ items: getTaskBox() });
}
