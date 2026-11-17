import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { photoDir, readContained } from "@/lib/paths";

export const dynamic = "force-dynamic";

// Serves screensaver photos from PHOTO_DIR (Docker: the ./photos mount) or
// DATA_DIR/photos. public/ can't serve runtime files in production.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  if (!/^[a-z0-9._-]+\.(jpg|jpeg|png|webp)$/i.test(file)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const buf = readContained(photoDir(), file);
  if (!buf) return NextResponse.json({ error: "Not found" }, { status: 404 });
  {
    const ext = path.extname(file).toLowerCase();
    const type = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    return new NextResponse(new Uint8Array(buf), {
      headers: { "Content-Type": type, "Cache-Control": "private, max-age=3600" },
    });
  }
}
