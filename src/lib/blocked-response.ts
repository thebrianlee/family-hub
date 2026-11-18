import { NextResponse } from "next/server";

import { isDbBlocked } from "./db";

/**
 * The answer for an API route when the database must not be used (lib/db.ts
 * DbBlockedError): 503 with the same code /api/health reports. The proxy
 * answers this way for most routes; the routes it lets through before reading
 * the database (setup, PIN) use this. Returns null for any other error.
 */
export function blockedResponse(e: unknown): NextResponse | null {
  if (!isDbBlocked(e)) return null;
  return NextResponse.json({ error: "The hub can't use its data right now", code: e.code }, { status: 503 });
}
