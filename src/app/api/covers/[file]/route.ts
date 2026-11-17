import { NextRequest, NextResponse } from "next/server";
import { coversDir, readContained } from "@/lib/paths";

export const dynamic = "force-dynamic";

// Serves cached cover images from data/covers/. Covers land there at
// runtime, and Next production won't serve runtime-added public/ files.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  if (!/^book-\d+\.jpg$/.test(file)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const buf = readContained(coversDir(), file);
  if (!buf) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, max-age=86400",
    },
  });
}
