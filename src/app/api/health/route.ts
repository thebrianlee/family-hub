import { getDb, isDbBlocked } from "@/lib/db";
import { setupComplete } from "@/lib/session";
import { APP_VERSION, SCHEMA_VERSION } from "@/lib/version";

export const dynamic = "force-dynamic";

const headers = { "cache-control": "no-store" };

// Liveness for the Docker healthcheck: the database opens and answers. It also
// reports the app version and schema number. Those are the same for every
// install of a build (this route needs no PIN), and nothing here describes the
// household. `setup` says whether first-run setup is finished, for the install
// helper (scripts/sproutwall doctor). Anyone on the network can already tell
// that from the setup screen, and /api/setup answers 409 once it is done.
export function GET() {
  try {
    getDb().prepare("SELECT 1").get();
    return Response.json(
      { ok: true, version: APP_VERSION, schema: SCHEMA_VERSION, setup: setupComplete() },
      { headers }
    );
  } catch (e) {
    if (isDbBlocked(e)) {
      return Response.json({ ok: false, code: e.code, ...e.details }, { status: 503, headers });
    }
    return Response.json({ ok: false }, { status: 503, headers });
  }
}
