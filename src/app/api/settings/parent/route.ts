import { NextRequest, NextResponse } from "next/server";

import { hasParentCookie, isParent, parentRequired } from "@/lib/guard";
import { attemptPin } from "@/lib/pin-attempts";
import {
  calendarSummary,
  checkCalendarLink,
  isCalendarOwner,
  parseCalendarLink,
  readHousehold,
  saveCalendarLink,
  saveHousehold,
  validateHouseholdBasics,
} from "@/lib/household-settings";
import {
  MemberError,
  addMember,
  getKids,
  getMembers,
  getParents,
  isMemberId,
  removeMember,
  replaceHousehold,
  updateMember,
  validateHousehold,
} from "@/lib/household";
import { refreshIcsNow } from "@/lib/ics";
import { isEnabled } from "@/lib/modules";
import { getSetting, setSetting } from "@/lib/queries";

export const dynamic = "force-dynamic";

// Parent settings. Reading needs the parent cookie (calendar hosts and the
// household setup are parent business); writing needs the cookie or the PIN.

function snapshot() {
  return {
    household: readHousehold(),
    calendars: calendarSummary(),
    privacy: { askShareFirstName: getSetting("ask_share_first_name", "0") === "1" },
    members: getMembers(),
  };
}

export async function GET(req: NextRequest) {
  if (!hasParentCookie(req)) return parentRequired();
  return NextResponse.json(snapshot());
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (!isParent(req, body)) return parentRequired();
  try {
    const refused = await apply(req, body);
    if (refused) return refused;
  } catch (err) {
    if (err instanceof MemberError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
  return NextResponse.json({ ok: true, ...snapshot() });
}

/** Apply one settings change. Returns a response only when the change is refused. */
async function apply(req: NextRequest, body: Record<string, unknown>): Promise<NextResponse | null> {
  switch (body.section) {
    case "household": {
      const checked = validateHouseholdBasics(body);
      if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
      saveHousehold(checked.value);
      break;
    }
    case "calendar": {
      if (!isCalendarOwner(body.owner)) return NextResponse.json({ error: "Unknown calendar owner." }, { status: 400 });
      const owner = body.owner;
      if (body.url === null || body.url === "") {
        saveCalendarLink(owner, null);
        break;
      }
      const normalized = parseCalendarLink(body.url);
      if (!normalized.ok) return NextResponse.json({ error: normalized.error }, { status: 400 });
      // Calendar switched off contacts no feed, not even to check the link.
      // The link is still saved, and the next refresh after Calendar is back
      // on pulls it in.
      if (!isEnabled("calendar")) {
        saveCalendarLink(owner, normalized.value);
        break;
      }
      const reachable = await checkCalendarLink(normalized.value);
      if (!reachable.ok) return NextResponse.json({ error: reachable.error }, { status: 400 });
      saveCalendarLink(owner, reachable.value);
      // Pull the new events in the background; the response doesn't wait.
      void refreshIcsNow().catch(() => {});
      break;
    }
    case "privacy": {
      if (typeof body.askShareFirstName !== "boolean") {
        return NextResponse.json({ error: "Invalid privacy setting." }, { status: 400 });
      }
      setSetting("ask_share_first_name", body.askShareFirstName ? "1" : "0");
      break;
    }
    case "member-add": {
      if (body.role !== "kid" && body.role !== "parent") {
        return NextResponse.json({ error: "Choose kid or parent." }, { status: 400 });
      }
      addMember(body, body.role);
      break;
    }
    case "member-update": {
      if (!isMemberId(body.id)) return NextResponse.json({ error: "Unknown member." }, { status: 400 });
      updateMember(body.id, { name: body.name, age: body.age, preReader: body.preReader, color: body.color });
      break;
    }
    case "member-remove": {
      if (!isMemberId(body.id)) return NextResponse.json({ error: "Unknown member." }, { status: 400 });
      const id = body.id;
      const group = getKids().some((k) => k.id === id) ? getKids() : getParents();
      if (group.length <= 1) {
        return NextResponse.json({ error: "The hub needs at least one kid and one parent." }, { status: 400 });
      }
      // Hidden, not deleted: their history stays and their name can come back.
      removeMember(id);
      break;
    }
    case "household-replace": {
      // Start over with a new family. Same rules and wipe as the setup wizard's
      // "Set up my family"; the UI asks the parent to confirm first.
      if (body.confirm !== "replace") return NextResponse.json({ error: "Confirm the replacement first." }, { status: 400 });
      // Destructive, so the PIN itself is required, not just a parent session.
      const pinCheck = attemptPin(req, body.pin);
      if (!pinCheck.ok) {
        return NextResponse.json(
          { error: pinCheck.locked ? "Too many wrong tries. Try again later." : "Enter the parent PIN to replace the family." },
          { status: 403 }
        );
      }
      const plan = validateHousehold(body.household);
      replaceHousehold(plan);
      break;
    }
    default:
      return NextResponse.json({ error: "Unknown settings section." }, { status: 400 });
  }
  return null;
}
