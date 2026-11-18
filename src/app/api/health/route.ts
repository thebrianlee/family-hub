import { getDb, isDbBlocked } from "@/lib/db";
import { APP_VERSION, SCHEMA_VERSION } from "@/lib/version";

export const dynamic = "force-dynamic";

const headers = { "cache-control": "no-store" };

// Liveness for the Docker healthcheck: the database opens and answers. It also
// reports the app version and schema number. Those are the same for every
// install of a build (this route needs no PIN), and nothing here describes the
// household.
export function GET() {
  try {
    getDb().prepare("SELECT 1").get();
    return Response.json({ ok: true, version: APP_VERSION, schema: SCHEMA_VERSION }, { headers });
  } catch (e) {
    if (isDbBlocked(e)) {
      return Response.json({ ok: false, code: e.code, ...e.details }, { status: 503, headers });
    }
    return Response.json({ ok: false }, { status: 503, headers });
  }
}
