import { applyHouseholdTimezone, getDb } from "./db";
import { getMembers } from "./household";
import { getSetting, setSetting } from "./queries";
import { dropUnconfiguredSources, fetchCalendarText } from "./ics";
import { ModuleOffError } from "./module-fetch";
import { SafeFetchError, type SafeGetOptions, type SafeResponse, safeGet } from "./safe-fetch";

// Parent settings: household basics, location, privacy and calendar links.
// Every value is validated here, so the settings route stays thin.

export type Household = {
  familyName: string;
  greeting: string;
  currency: string;
  timezone: string;
  latitude: number;
  longitude: number;
};

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export function isValidTimezone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function validateHouseholdBasics(input: Record<string, unknown>): Result<Household> {
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const familyName = text(input.familyName, 60);
  const greeting = text(input.greeting, 40);
  const currency = text(input.currency, 30);
  const timezone = text(input.timezone, 64);
  const latitude = Number(input.latitude);
  const longitude = Number(input.longitude);
  if (!familyName || !greeting || !currency) {
    return { ok: false, error: "Name the household, the greeting, and the points." };
  }
  if (!isValidTimezone(timezone)) return { ok: false, error: "That timezone is not recognized." };
  if (
    input.latitude === "" ||
    input.longitude === "" ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    return { ok: false, error: "Check the latitude and longitude." };
  }
  return { ok: true, value: { familyName, greeting, currency, timezone, latitude, longitude } };
}

export function readHousehold(): Household {
  return {
    familyName: getSetting("family_name", ""),
    greeting: getSetting("family_greeting", ""),
    currency: getSetting("currency_name", ""),
    timezone: getSetting("timezone", ""),
    latitude: Number(getSetting("weather_lat", "0")),
    longitude: Number(getSetting("weather_lon", "0")),
  };
}

export function saveHousehold(h: Household): void {
  const db = getDb();
  const moved =
    getSetting("weather_lat", "") !== String(h.latitude) || getSetting("weather_lon", "") !== String(h.longitude);
  const rezoned = getSetting("timezone", "") !== h.timezone;
  db.transaction(() => {
    setSetting("family_name", h.familyName);
    setSetting("family_greeting", h.greeting);
    setSetting("currency_name", h.currency);
    setSetting("timezone", h.timezone);
    setSetting("weather_lat", String(h.latitude));
    setSetting("weather_lon", String(h.longitude));
    if (moved || rezoned) {
      // The cached forecast is for the old place or zone.
      setSetting("weather_cache", "");
      setSetting("weather_fetched_at", "0");
    }
  })();
  if (rezoned) applyHouseholdTimezone(db);
}

// ---------- calendar links ----------

export const SHARED_KIDS_CALENDAR = "kids_shared";

/** Who can have a calendar link: every member, plus one shared kids' feed. */
export function calendarOwners(): { id: string; label: string }[] {
  return [
    ...getMembers().map((m) => ({ id: m.id, label: m.name })),
    { id: SHARED_KIDS_CALENDAR, label: "Kids' shared calendar" },
  ];
}

export function isCalendarOwner(id: unknown): id is string {
  return typeof id === "string" && calendarOwners().some((o) => o.id === id);
}

/**
 * Accept what calendar apps hand out: https:// or webcal:// secret addresses
 * (webcal is plain https underneath). Plain http is allowed because some
 * school and team calendars still use it.
 */
export function parseCalendarLink(raw: unknown): Result<string> {
  if (typeof raw !== "string") return { ok: false, error: "Paste the calendar's secret address." };
  let text = raw.trim();
  if (!text) return { ok: false, error: "Paste the calendar's secret address." };
  if (text.length > 2000) return { ok: false, error: "That address is too long to be a calendar link." };
  if (/^webcals?:\/\//i.test(text)) text = text.replace(/^webcals?:\/\//i, "https://");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: "That doesn't look like a web address." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "Calendar links start with https://, webcal:// or http://." };
  }
  if (url.username || url.password) return { ok: false, error: "Remove the user name and password from the link." };
  return { ok: true, value: url.toString() };
}

/**
 * Fetch the link once exactly as the sync will (src/lib/ics.ts: safe-fetch
 * guard on every hop, up to 3 redirects, never https -> http) and check that
 * it is a calendar. Turns the reasons into words a parent can act on.
 * Calendar switched off before a hop starts is not a reason: ModuleOffError
 * is thrown on to the caller, which stops.
 */
export async function checkCalendarLink(
  url: string,
  get: (url: string, opts: SafeGetOptions) => Promise<SafeResponse> = safeGet
): Promise<Result<string>> {
  try {
    await fetchCalendarText(url, get);
    return { ok: true, value: url };
  } catch (err) {
    if (err instanceof ModuleOffError) throw err;
    if (err instanceof SafeFetchError) {
      // Private-network targets, oversized feeds and timeouts land here.
      return { ok: false, error: `Couldn't use that link: ${err.message}.` };
    }
    const reason = err instanceof Error ? err.message : "";
    if (/^HTTP (401|403|404|410)\b/.test(reason)) {
      return { ok: false, error: "The calendar service refused that link. Copy the secret address again." };
    }
    if (/did not return a calendar/.test(reason)) {
      return { ok: false, error: "That page isn't a calendar feed. Use the secret iCal address, not the calendar's web page." };
    }
    if (/redirect/.test(reason)) {
      return { ok: false, error: `That link sends the hub somewhere it won't follow (${reason}).` };
    }
    if (/^HTTP \d+/.test(reason)) return { ok: false, error: `The calendar service answered with an error (${reason}).` };
    return { ok: false, error: "Couldn't reach that calendar. Check the link and the hub's internet connection." };
  }
}

export function calendarSummary(): { id: string; label: string; linked: boolean; host: string | null }[] {
  return calendarOwners().map((o) => {
    const url = getSetting(`ics_url_${o.id}`, "");
    let host: string | null = null;
    if (url) {
      try {
        host = new URL(url).hostname;
      } catch {
        host = null;
      }
    }
    // The address itself is a secret; only show where it points.
    return { ...o, linked: url !== "", host };
  });
}

/** Save or clear a link. Clearing it removes that calendar's events right away. */
export function saveCalendarLink(owner: string, url: string | null): void {
  const db = getDb();
  db.transaction(() => {
    setSetting(`ics_url_${owner}`, url ?? "");
    if (!url) dropUnconfiguredSources(db);
  })();
}
