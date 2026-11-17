import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { isDemoMode, demoShowFaces } from "@/lib/demo";
import { avatarsDir, readContained } from "@/lib/paths";

export const dynamic = "force-dynamic";

// Member headshots from data/avatars (photo folder-synced). 404 = caller falls
// back to the colored-name style. In demo mode the cartoon dinos in
// public/demo-avatars/ are served instead so no real faces appear on camera.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  if (!/^[a-z0-9-]+\.jpg$/.test(file)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (isDemoMode() && !demoShowFaces()) {
    const svg = path.join(process.cwd(), "public", "demo-avatars", file.replace(/\.jpg$/, ".svg"));
    try {
      const buf = fs.readFileSync(svg);
      return new NextResponse(new Uint8Array(buf), {
        headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-cache, must-revalidate" },
      });
    } catch {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  }
  const svg = path.join(process.cwd(), "public", "demo-avatars", file.replace(/\.jpg$/, ".svg"));
  try {
    const photo = readContained(avatarsDir(), file);
    const buf = photo ?? fs.readFileSync(svg);
    const svgFile = !photo;
    // Avatars can be replaced under the same filename — always revalidate so
    // a new photo shows immediately instead of a stale cached crop.
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": svgFile ? "image/svg+xml" : "image/jpeg",
        "Cache-Control": "no-cache, must-revalidate",
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
