import { NextResponse } from "next/server";
import { getSparkTile } from "@/lib/spark";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getSparkTile());
}
