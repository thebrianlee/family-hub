// ICS calendar fetcher — runs ON THE PI, no OAuth, no expiring tokens.
//
// Each family member's Google Calendar "secret address in iCal format" is
// stored in the settings table as ics_url_<member> (installed at deploy time,
// never committed). refreshIcsIfStale() is fired (non-blocking) from
// /api/today; it refetches every REFRESH_MINUTES and writes the same
// synced_events table the OAuth pipeline used, so the provider and its
// placeholder fallback are untouched.

import ical from "node-ical";
import { getDb } from "./db";
import { ModuleOffError, moduleGet } from "./module-fetch";
import { safeGet, type SafeGetter } from "./safe-fetch";
import { getSetting, setSetting } from "./queries";
import { getMembers } from "./household";
import type { MemberRecord } from "./family";

const REFRESH_MINUTES = 15;
const WINDOW_DAYS = 120; // ~4 months ahead so the Calendar month/week views have real data
const WINDOW_BACK_DAYS = 14; // reach back so the current month's earlier days show
function zone(): string {
  return getSetting("timezone", "America/Chicago");
}

const MAX_ICS_BYTES = 10 * 1024 * 1024;
// A few bytes of RRULE can describe thousands of instances (FREQ=HOURLY, or
// BYHOUR/BYMINUTE lists). Each recurring event keeps at most its earliest
// MAX_INSTANCES_PER_EVENT instances in the window, and each feed at most its
// earliest MAX_ROWS_PER_FEED rows.
export const MAX_INSTANCES_PER_EVENT = 500;
export const MAX_ROWS_PER_FEED = 5000;
let inflight: Promise<void> | null = null;
let lastCompletedAt = 0;
/** Feeds already reported as capped, so the log says it once, not every 15 minutes. */
const cappedLogged = new Set<string>();

function nyParts(dt: Date): { date: string; time: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(dt).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`,
  };
}

interface Row {
  id: string;
  member: string;
  title: string;
  date: string;
  start: string | null;
  end: string | null;
  location: string | null;
}

type IcsDate = Date & { dateOnly?: boolean };

type VEvent = {
  type?: string;
  summary?: unknown;
  location?: unknown;
  start?: IcsDate;
  end?: Date;
  uid?: string;
  status?: string;
  rrule?: { between: (from: Date, to: Date, inc?: boolean) => Date[] };
  recurrenceid?: IcsDate;
  // node-ical (see its README, "Exception dates (EXDATE) and Recurrence
  // overrides (RECURRENCE-ID)"): keyed by "YYYY-MM-DD" and, for date-time
  // values, also by the full ISO instant. Both keys hold the same object.
  exdate?: Record<string, IcsDate>;
  recurrences?: Record<string, VEvent>;
};

function isAllDay(ev: VEvent): boolean {
  return ev.start?.dateOnly === true;
}

function asText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "val" in v) return String((v as { val: unknown }).val ?? "");
  return "";
}

/** "YYYY-MM-DD" from local getters, as node-ical keys date-only values. */
function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Occurrence starts of a rule in the window, earliest first, at most `cap`.
 * The window is expanded in growing steps from the series' first possible
 * occurrence (`anchor`: DTSTART, or the window start for a series already
 * running), so a dense rule stops after its first hour or day instead of
 * being expanded across months. A rule that node-ical refuses to expand
 * further (its own iteration limit) keeps what was found before it.
 */
function occurrences(
  rrule: NonNullable<VEvent["rrule"]>,
  from: Date,
  to: Date,
  anchor: Date,
  cap: number
): { dates: Date[]; capped: boolean } {
  const dates: Date[] = [];
  const seen = new Set<number>();
  let windowStart = from;
  for (const span of [3_600_000, 86_400_000, 8 * 86_400_000, 64 * 86_400_000, Infinity]) {
    const windowEnd = new Date(Math.min(to.getTime(), anchor.getTime() + span));
    if (windowEnd <= windowStart) continue;
    let found: Date[];
    try {
      found = rrule.between(windowStart, windowEnd, true);
    } catch (err) {
      if (dates.length === 0) throw err;
      return { dates, capped: true };
    }
    // Windows share their edges (between() includes both ends).
    for (const d of found) {
      if (seen.has(d.getTime())) continue;
      seen.add(d.getTime());
      dates.push(d);
    }
    if (dates.length > cap) return { dates: dates.slice(0, cap), capped: true };
    windowStart = windowEnd;
  }
  return { dates, capped: false };
}

/** Expand one VEVENT (including recurrences) into per-day rows inside [from, to). */
function expandEvent(ev: VEvent, member: string, from: Date, to: Date): { rows: Row[]; capped: boolean } {
  const rows: Row[] = [];
  const baseTitle = asText(ev.summary) || "(untitled)";
  const baseLocation = asText(ev.location).slice(0, 200) || null;
  const durationMs = ev.end && ev.start ? ev.end.getTime() - ev.start.getTime() : 0;

  const pushInstance = (
    start: Date,
    end: Date | null,
    allDay: boolean,
    key: string,
    title = baseTitle,
    location = baseLocation
  ) => {
    if (allDay) {
      // google all-day: end date exclusive; emit one row per covered day in-window
      const last = end ?? new Date(start.getTime() + 86_400_000);
      for (let d = new Date(start), i = 0; d < last && i < 14; d = new Date(d.getTime() + 86_400_000), i++) {
        if (d < from || d >= to) continue;
        rows.push({ id: `${key}:${nyParts(d).date}`, member, title, date: nyParts(d).date, start: null, end: null, location });
      }
    } else {
      if (start < from || start >= to) return;
      const s = nyParts(start);
      const e = end ? nyParts(end) : null;
      rows.push({
        id: key,
        member,
        title,
        date: s.date,
        start: s.time,
        end: e && e.date === s.date ? e.time : null,
        location,
      });
    }
  };

  /** A moved or edited occurrence, shown under the original occurrence's key. */
  const pushOverride = (o: VEvent, key: string) => {
    if (o.status === "CANCELLED" || !o.start) return;
    const end = o.end ?? (durationMs ? new Date(o.start.getTime() + durationMs) : null);
    pushInstance(o.start, end, isAllDay(o), key, asText(o.summary) || baseTitle, asText(o.location).slice(0, 200) || baseLocation);
  };

  const allDay = isAllDay(ev);
  if (!ev.rrule) {
    pushInstance(ev.start as Date, (ev.end as Date) ?? null, allDay, String(ev.uid ?? `${member}-${ev.start}`));
    return { rows, capped: false };
  }

  const anchor = ev.start && ev.start > from ? ev.start : from;
  const { dates, capped } = occurrences(ev.rrule, from, to, anchor, MAX_INSTANCES_PER_EVENT);
  const exdate = ev.exdate ?? {};
  const overrides = ev.recurrences ?? {};
  const used = new Set<VEvent>();
  for (const inst of dates) {
    const key = `${ev.uid}:${inst.toISOString()}`;
    // All-day series compare calendar days. Timed series compare the exact
    // instant, so excluding the 3 pm instance leaves the 4 pm one; a date-only
    // EXDATE on a timed series still removes that whole day.
    const day = localDateKey(inst);
    const excluded = allDay
      ? Object.hasOwn(exdate, day)
      : Object.hasOwn(exdate, inst.toISOString()) || exdate[day]?.dateOnly === true;
    if (excluded) continue;
    const override = allDay ? overrides[day] : overrides[inst.toISOString()];
    if (override) {
      used.add(override);
      pushOverride(override, key);
      continue;
    }
    const end = durationMs ? new Date(inst.getTime() + durationMs) : null;
    pushInstance(inst, end, allDay, key);
  }
  // Overrides whose original occurrence is not in the list above, for example
  // one moved into the window from outside it.
  for (const o of new Set(Object.values(overrides))) {
    if (used.has(o) || !o.recurrenceid) continue;
    pushOverride(o, `${ev.uid}:${o.recurrenceid.toISOString()}`);
  }
  return { rows, capped };
}

const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** webcal:// and webcals:// links (what "Subscribe" buttons hand out) are the same feed over https. */
export function normalizeCalendarUrl(raw: string): string {
  return raw.trim().replace(/^webcals?:\/\//i, "https://");
}

/**
 * Fetch a calendar feed and return its text. Follows up to MAX_REDIRECTS
 * redirects (iCloud sends published calendars to another partition host).
 * Every hop is a fresh safeGet, so the public-address check runs at connect
 * time on each one, and an https link is never followed down to http. Every
 * hop goes through moduleGet, so no hop starts once Calendar is off
 * (ModuleOffError). Anything but a 200 whose body is a calendar throws, so the
 * caller keeps the rows it already has. `get` is injectable for tests.
 */
export async function fetchCalendarText(rawUrl: string, get: SafeGetter = safeGet): Promise<string> {
  let current = normalizeCalendarUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await moduleGet(
      "calendar",
      current,
      { maxBytes: MAX_ICS_BYTES, timeoutMs: 30_000, allowHttp: true, accept: "text/calendar" },
      get
    );
    if (REDIRECT_STATUSES.has(res.status)) {
      if (!res.location) throw new Error(`HTTP ${res.status} without a Location`);
      let next: URL;
      try {
        next = new URL(res.location, current);
      } catch {
        throw new Error("redirect to an invalid link");
      }
      if (new URL(current).protocol === "https:" && next.protocol !== "https:") {
        throw new Error("refusing a redirect from https to a non-https link");
      }
      current = next.toString();
      continue;
    }
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const text = res.body.toString("utf8");
    // A 200 can still be a sign-in page or a "this link has expired" page.
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("the link did not return a calendar");
    return text;
  }
  throw new Error(`more than ${MAX_REDIRECTS} redirects`);
}

async function fetchMember(member: string, url: string, from: Date, to: Date, get: SafeGetter): Promise<Row[]> {
  let text: string;
  try {
    text = await fetchCalendarText(url, get);
  } catch (err) {
    if (err instanceof ModuleOffError) throw err; // the refresh stops; see refreshIcs
    // The link itself is not added to the message: calendar addresses are secrets.
    throw new Error(`ICS fetch ${member}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = ical.sync.parseICS(text);

  // node-ical files an override (RECURRENCE-ID) under its series' `recurrences`;
  // a top-level entry with a RECURRENCE-ID is one whose series is missing from
  // the feed, and is shown as a single event.
  const events = Object.values(parsed).filter((entry) => (entry as VEvent | undefined)?.type === "VEVENT") as VEvent[];
  let rows: Row[] = [];
  let cappedEvents = 0;
  let feedCapped = false;
  const at = (r: Row) => `${r.date} ${r.start ?? ""}`;
  const keepEarliest = () => {
    rows = rows.sort((a, b) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0)).slice(0, MAX_ROWS_PER_FEED);
  };
  for (const ev of events) {
    if (ev.status === "CANCELLED") continue;
    const expanded = expandEvent(ev, member, from, to);
    if (expanded.capped) cappedEvents++;
    rows.push(...expanded.rows);
    // Bound memory while expanding (a hostile feed can hold thousands of
    // recurring events): compact to the earliest rows whenever the buffer
    // passes twice the cap. The result is the same as capping at the end.
    if (rows.length > 2 * MAX_ROWS_PER_FEED) {
      feedCapped = true;
      keepEarliest();
    }
  }
  if (rows.length > MAX_ROWS_PER_FEED) {
    feedCapped = true;
    keepEarliest();
  }
  if ((cappedEvents || feedCapped) && !cappedLogged.has(member)) {
    cappedLogged.add(member);
    console.warn(
      `[ics] ${member}: kept the earliest ${MAX_INSTANCES_PER_EVENT} instances of ${cappedEvents} recurring event(s)` +
        (feedCapped ? ` and the earliest ${MAX_ROWS_PER_FEED} rows of the feed` : "")
    );
  }
  return rows;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches "<name> - ", "<name>: " or "<name> – " at the start of a title. */
function namePrefix(name: string): RegExp {
  return new RegExp(`^\\s*${escapeRegExp(name)}\\s*[-–:]\\s*`, "i");
}

/** "Mila - Chinese Lesson" on Mila's row is redundant — strip the matching prefix. */
export function stripNamePrefix(title: string, name: string | undefined): string {
  if (!name) return title;
  return title.replace(namePrefix(name), "") || title;
}

/**
 * Which kids a shared-feed event belongs to: the kid whose name prefixes the
 * title ("Mila - Swim"), otherwise every kid. Names come from the members table.
 */
export function sharedFeedTargets(title: string, kids: readonly Pick<MemberRecord, "id" | "name">[]): string[] {
  // Longest name first, so "Jo-Ann - Swim" goes to Jo-Ann, not Jo.
  const byLength = [...kids].sort((a, b) => [...b.name].length - [...a.name].length);
  const owner = byLength.find((k) => namePrefix(k.name).test(title));
  return owner ? [owner.id] : kids.map((k) => k.id);
}

type Db = ReturnType<typeof getDb>;

/**
 * Drop the rows of calendar sources that are no longer configured: a member's
 * own rows once their link is empty, every shared-feed row once the shared
 * link is empty, and rows from before the source column (source NULL) of a
 * member that no configured link covers any more. Runs at the end of every
 * refresh and right after a link is removed in Settings. A link that is set
 * but failing keeps its rows: that is the refresh's job, not this one.
 */
export function dropUnconfiguredSources(db: Db = getDb()): void {
  const sharedSet = getSetting("ics_url_kids_shared", "") !== "";
  const kids = new Set(getMembers().filter((m) => m.role === "kid").map((m) => m.id));
  const ownSet = (member: string) => getSetting(`ics_url_${member}`, "") !== "";
  db.transaction(() => {
    if (!sharedSet) db.prepare("DELETE FROM synced_events WHERE source='shared'").run();
    const members = (db.prepare("SELECT DISTINCT member FROM synced_events WHERE source='own' OR source IS NULL").all() as {
      member: string;
    }[]).map((r) => r.member);
    for (const member of members) {
      if (ownSet(member)) continue;
      db.prepare("DELETE FROM synced_events WHERE member=? AND source='own'").run(member);
      if (!(sharedSet && kids.has(member))) {
        db.prepare("DELETE FROM synced_events WHERE member=? AND source IS NULL").run(member);
      }
    }
  })();
}

/**
 * Refetch every configured feed and replace each source's rows, but only for
 * sources that fetched and parsed; a failed source keeps what it had. Sources
 * that are no longer configured lose their rows. Callers go through
 * startRefresh(); `get` is injectable for tests.
 *
 * Calendar switched off during a refresh: the next feed (or redirect hop) is
 * refused before it starts (moduleGet), and the refresh stops there. It
 * writes nothing and leaves ics_last_refresh alone, so the first refresh
 * after Calendar is back on runs at once.
 */
export async function refreshIcs(get: SafeGetter = safeGet): Promise<void> {
  const household = getMembers();
  const nameOf = new Map(household.map((m) => [m.id, m.name]));
  const kids = household.filter((m) => m.role === "kid");
  const members = household.map((m) => m.id).filter((m) => getSetting(`ics_url_${m}`, "") !== "");
  const sharedUrl = getSetting("ics_url_kids_shared", "");
  if (members.length === 0 && !sharedUrl) {
    dropUnconfiguredSources();
    return;
  }

  const from = new Date();
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - WINDOW_BACK_DAYS);
  const to = new Date(from.getTime() + (WINDOW_DAYS + WINDOW_BACK_DAYS) * 86_400_000);

  const results = await Promise.allSettled(
    members.map(async (m): Promise<{ member: string; rows: Row[] }> => ({
      member: m,
      rows: await fetchMember(m, getSetting(`ics_url_${m}`), from, to, get),
    }))
  );

  if (results.some((r) => r.status === "rejected" && r.reason instanceof ModuleOffError)) return;

  // Shared kids calendar: "<Kid> - X" routes to that kid only; unprefixed
  // events go to every kid's row.
  const sharedByKid = new Map<string, Row[]>(kids.map((k) => [k.id, []]));
  let sharedFailed = false;
  if (sharedUrl) {
    try {
      const sharedRows = await fetchMember("kids", sharedUrl, from, to, get);
      for (const row of sharedRows) {
        for (const kid of sharedFeedTargets(row.title, kids)) {
          sharedByKid.get(kid)!.push({ ...row, id: `${row.id}:${kid}`, member: kid });
        }
      }
    } catch (err) {
      if (err instanceof ModuleOffError) return;
      sharedFailed = true;
      console.error("[ics] shared kids feed failed:", String(err));
    }
  }

  const ok = results.filter((r): r is PromiseFulfilledResult<{ member: string; rows: Row[] }> => r.status === "fulfilled");
  const own = new Map(ok.map((r) => [r.value.member, r.value.rows]));
  const sharedOk = Boolean(sharedUrl) && !sharedFailed;

  // Every row carries its source ('own' or 'shared'), and each source that
  // fetched replaces only its own rows, so one feed failing never wipes
  // another feed's events. Ids stay source-prefixed ("<member>:<uid…>" and
  // "shared:<uid…>:<kid>") only to keep them unique.
  //
  // Rows written before the source column have source NULL and cannot be
  // told apart. They go once any feed of their member has been refreshed (its
  // fresh rows replace them), or when no link covers the member any more.
  const db = getDb();
  const ins = db.prepare(
    "INSERT OR REPLACE INTO synced_events (id, member, title, date, start, end, location, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const put = (id: string, r: Row, source: "own" | "shared") =>
    ins.run(id, r.member, stripNamePrefix(r.title, nameOf.get(r.member)).slice(0, 200), r.date, r.start, r.end, r.location, source);
  const dropLegacy = db.prepare("DELETE FROM synced_events WHERE member=? AND source IS NULL");
  db.transaction(() => {
    for (const [member, rows] of own) {
      db.prepare("DELETE FROM synced_events WHERE member=? AND source='own'").run(member);
      dropLegacy.run(member);
      for (const r of rows) put(`${member}:${r.id}`, r, "own");
    }
    if (sharedOk) {
      db.prepare("DELETE FROM synced_events WHERE source='shared'").run();
      for (const { id: kid } of kids) {
        dropLegacy.run(kid);
        for (const r of sharedByKid.get(kid) ?? []) put(`shared:${r.id}`, r, "shared");
      }
    }
    // Last, so a link removed while the feeds were downloading still loses its rows.
    dropUnconfiguredSources(db);
  })();

  const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  if (failed.length) console.error("[ics] partial refresh:", failed.map((f) => String(f.reason)).join("; "));
  setSetting("ics_last_refresh", new Date().toISOString());
  console.log(`[ics] refreshed ${ok.length}/${members.length} calendars, ${ok.reduce((n, r) => n + r.value.rows.length, 0)} events`);
}

function startRefresh(): Promise<void> {
  if (!inflight) {
    inflight = refreshIcs().finally(() => {
      inflight = null;
      lastCompletedAt = Date.now();
    });
  }
  return inflight;
}

/** Fire-and-forget staleness check; called from /api/today on each poll. */
export function refreshIcsIfStale(): void {
  const last = getSetting("ics_last_refresh", "");
  const stale = !last || Date.now() - new Date(last).getTime() > REFRESH_MINUTES * 60_000;
  if (!stale || inflight) return;
  startRefresh().catch((err) => console.error("[ics] refresh failed:", err));
}

/** Blocking refresh, used after a link is saved. Joins a refresh already running. */
export async function refreshIcsNow(): Promise<void> {
  await startRefresh();
}

/**
 * The manual /api/events/refresh button. Joins a refresh already running; if
 * one finished less than `cooldownMs` ago, refetches nothing and reports that
 * the stored events are what there is.
 */
export async function refreshIcsManual(cooldownMs = 60_000): Promise<{ refreshed: boolean }> {
  if (!inflight && lastCompletedAt && Date.now() - lastCompletedAt < cooldownMs) return { refreshed: false };
  await startRefresh();
  return { refreshed: true };
}
