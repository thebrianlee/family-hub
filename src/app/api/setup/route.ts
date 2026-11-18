import { NextRequest, NextResponse } from "next/server";
import { hashPin } from "@/lib/auth";
import { applyHouseholdTimezone, getDb } from "@/lib/db";
import { getSetting, setSetting } from "@/lib/queries";
import { HouseholdPlan, MemberError, replaceHousehold, validateHousehold } from "@/lib/household";
import { pinProblem } from "@/lib/weak-pin";
import { blockedResponse } from "@/lib/blocked-response";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    return await handlePost(req);
  } catch (e) {
    // The proxy lets this route through before it reads the database, so a
    // blocked database (lib/db.ts) surfaces here: answer 503, not a crash.
    const blocked = blockedResponse(e);
    if (blocked) return blocked;
    throw e;
  }
}

async function handlePost(req: NextRequest): Promise<NextResponse> {
  if (getSetting("setup_complete", "0") === "1") {
    return NextResponse.json({ error: "This hub is already set up." }, { status: 409 });
  }
  const body = await req.json().catch(() => ({}));
  const pin = String(body.pin ?? "");
  const problem = pinProblem(pin);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  const familyName = String(body.familyName ?? "").trim().slice(0, 60);
  const greeting = String(body.greeting ?? "").trim().slice(0, 40);
  const currency = String(body.currency ?? "").trim().slice(0, 30);
  const timezone = String(body.timezone ?? "").trim();
  const latitude = Number(body.latitude);
  const longitude = Number(body.longitude);
  if (!familyName || !greeting || !currency) {
    return NextResponse.json({ error: "Name the household, the greeting, and the points." }, { status: 400 });
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    return NextResponse.json({ error: "That timezone is not recognized." }, { status: 400 });
  }
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return NextResponse.json({ error: "Check the latitude and longitude." }, { status: 400 });
  }
  // "Your family": keep the sample family (the default, and what older clients
  // send) or replace it with the household typed into the wizard.
  const mode = body.household === undefined ? "sample" : body.household?.mode;
  if (mode !== "sample" && mode !== "custom") {
    return NextResponse.json({ error: "Choose the sample family or set up your own." }, { status: 400 });
  }
  let plan: HouseholdPlan | null = null;
  if (mode === "custom") {
    try {
      plan = validateHousehold(body.household);
    } catch (err) {
      if (err instanceof MemberError) return NextResponse.json({ error: err.message }, { status: 400 });
      throw err;
    }
  }
  const hashed = hashPin(pin);
  // Re-check and claim inside one synchronous transaction. The check at the
  // top can be stale: another setup may have finished while this request's
  // body was still arriving. Only the first claim wins.
  const db = getDb();
  const claimed = db.transaction(() => {
    if (getSetting("setup_complete", "0") === "1") return false;
    setSetting("parent_pin", `${hashed.salt}:${hashed.hash}`);
    // Fresh PIN, no leftover wrong-try counters or locks (all "pin_*" keys).
    db.prepare("DELETE FROM settings WHERE key LIKE 'pin\\_%' ESCAPE '\\'").run();
    setSetting("family_name", familyName);
    setSetting("family_greeting", greeting);
    setSetting("currency_name", currency);
    setSetting("timezone", timezone);
    setSetting("weather_lat", String(latitude));
    setSetting("weather_lon", String(longitude));
    // Same transaction: a second setup can never see a half-replaced household.
    if (plan) replaceHousehold(plan);
    setSetting("setup_complete", "1");
    return true;
  })();
  if (!claimed) {
    return NextResponse.json({ error: "This hub is already set up." }, { status: 409 });
  }
  applyHouseholdTimezone(db);
  return NextResponse.json({ ok: true });
}
