import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getQuotes, getFamilyRules } from "@/lib/spark";
import { getSetting } from "@/lib/queries";
import { getWeather } from "@/lib/weather";
import { isDemoMode, demoShowFaces } from "@/lib/demo";
import { photoDir } from "@/lib/paths";

export const dynamic = "force-dynamic";

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

// Photos live in PHOTO_DIR (or DATA_DIR/photos) and are served by
// /api/photos — public/ only serves files that existed at build time.
function listImages(abs: string, urlPrefix: string): string[] {
  try {
    return fs
      .readdirSync(abs)
      .filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()) && /^[a-z0-9._-]+$/i.test(f))
      .map((f) => `${urlPrefix}/${encodeURIComponent(f)}`);
  } catch {
    return [];
  }
}

// Screensaver + sleep-mode payload: slide content and timing settings.
export async function GET() {
  return NextResponse.json({
    weather: await getWeather(),
    // Full-anonymize demo hides photos; featured-family demo (and normal use)
    // shows whatever is in data/photos.
    photos: isDemoMode() && !demoShowFaces() ? [] : listImages(photoDir(), "/api/photos"),
    // Art slides deferred — drop images into data/photos for now; a separate
    // art folder + route can come back when someone wants it.
    art: [],
    quotes: [...getQuotes(), ...getFamilyRules()],
    idleMinutes: Number(getSetting("screensaver_idle_min", "10")),
    sleepStart: getSetting("sleep_start", "21:30"),
    sleepEnd: getSetting("sleep_end", "06:00"),
    // When on, the Pi physically powers the display off during the sleep
    // window (power-manager.sh), so the app must NOT paint its own black
    // overlay — otherwise a night touch wakes the screen to a black app.
    hardwareSleep: getSetting("hardware_sleep", "1") === "1",
  });
}
