import { NextRequest, NextResponse } from "next/server";
import { downloadCover, isAllowedCoverUrl } from "@/lib/books";
import { ModuleOffError } from "@/lib/module-fetch";
import { isEnabled } from "@/lib/modules";

export const dynamic = "force-dynamic";

// A book search result's cover, fetched by the hub so that the browser never
// contacts a book site itself (src/lib/cover-preview.ts). Reading owns
// /api/books, so the proxy's module gate covers this route. A parent's read
// passes that gate while Reading is off, so it is checked here too; and the
// download goes the guarded way covers are cached (downloadCover): the cover
// host allowlist, the size cap and the timeout, and a module check before
// every hop (moduleGet).
export async function GET(req: NextRequest) {
  if (!isEnabled("reading")) return NextResponse.json({ error: "module_off" }, { status: 404 });
  const url = req.nextUrl.searchParams.get("url") ?? "";
  if (!isAllowedCoverUrl(url)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  let buf: Buffer;
  try {
    buf = await downloadCover(url);
  } catch (err) {
    if (err instanceof ModuleOffError) return NextResponse.json({ error: "module_off" }, { status: 404 });
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // Switched off while the image downloaded: the screen gets nothing.
  if (!isEnabled("reading")) return NextResponse.json({ error: "module_off" }, { status: 404 });
  // Served like a cached cover (/api/covers): as an image, never sniffed as
  // anything else (next.config.ts sends nosniff).
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, max-age=86400",
    },
  });
}
