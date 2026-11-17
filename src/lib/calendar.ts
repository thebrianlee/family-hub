// Calendar provider.
//
// Two backing stores, one interface:
//  - synced_events: events from the household's iCal links (lib/ics.ts).
//  - events: the sample table (day offsets relative to today). It is shown
//    only while no calendar link is configured, so a real but empty calendar
//    is never filled with made-up appointments.

import { getDb } from "./db";
import { MemberId } from "./family";
import { isDemoMode, getDemoEvents } from "./demo";

export interface CalendarEvent {
  id: string;
  member: MemberId;
  title: string;
  /** ISO date YYYY-MM-DD */
  date: string;
  /** 24h "HH:MM", omit for all-day */
  start?: string;
  end?: string;
  location?: string;
  countdown?: boolean;
}

export interface CalendarProvider {
  /** Events from today through +6 days, all family members. */
  getWeekEvents(today: Date): Promise<CalendarEvent[]>;
}

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function hasCalendarLinks(): boolean {
  return Boolean(
    getDb().prepare("SELECT 1 FROM settings WHERE key LIKE 'ics_url_%' AND value <> '' LIMIT 1").get()
  );
}

class SyncedCalendarProvider implements CalendarProvider {
  async getWeekEvents(today: Date): Promise<CalendarEvent[]> {
    const db = getDb();
    const from = iso(today);
    const rows = db
      .prepare(
        "SELECT id, member, title, date, start, end, location FROM synced_events WHERE date >= ? ORDER BY date, start"
      )
      .all(from) as {
      id: string;
      member: MemberId;
      title: string;
      date: string;
      start: string | null;
      end: string | null;
      location: string | null;
    }[];

    const base =
      rows.length > 0 || hasCalendarLinks()
        ? rows.map((r) => ({
            id: r.id,
            member: r.member,
            title: r.title,
            date: r.date,
            start: r.start ?? undefined,
            end: r.end ?? undefined,
            location: r.location ?? undefined,
          }))
        : placeholderEvents(today);
    // Wall-created events (the ＋ Add flow) always merge in on top.
    return [...base, ...wallEvents(today)];
  }
}

interface WallRow {
  id: number;
  member: MemberId;
  title: string;
  date: string;
  start: string | null;
  end: string | null;
  location: string | null;
  countdown: number;
}
function mapWall(r: WallRow): CalendarEvent {
  return {
    id: `wall-${r.id}`,
    member: r.member,
    title: r.title,
    date: r.date,
    start: r.start ?? undefined,
    end: r.end ?? undefined,
    location: r.location ?? undefined,
    countdown: !!r.countdown,
  };
}

/** Events created on the wall itself, from today forward. */
function wallEvents(today: Date): CalendarEvent[] {
  const rows = getDb()
    .prepare("SELECT id, member, title, date, start, end, location, countdown FROM wall_events WHERE date >= ? ORDER BY date, start")
    .all(iso(today)) as WallRow[];
  return rows.map(mapWall);
}

/** Placeholder schedule from the seeded `events` table (day offsets). */
function placeholderEvents(today: Date): CalendarEvent[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT id, member, title, day_offset, start, end, location FROM events ORDER BY day_offset, start")
    .all() as {
    id: number;
    member: MemberId;
    title: string;
    day_offset: number;
    start: string | null;
    end: string | null;
    location: string | null;
  }[];
  return rows.map((r) => {
    const d = new Date(today);
    d.setDate(d.getDate() + r.day_offset);
    return {
      id: String(r.id),
      member: r.member,
      title: r.title,
      date: iso(d),
      start: r.start ?? undefined,
      end: r.end ?? undefined,
      location: r.location ?? undefined,
    };
  });
}

const syncedProvider = new SyncedCalendarProvider();

// Demo mode swaps the whole event layer for the anonymized schedule so no
// real school / names / addresses can leak into a recording.
export const calendarProvider: CalendarProvider = {
  async getWeekEvents(today: Date): Promise<CalendarEvent[]> {
    if (isDemoMode()) {
      const end = new Date(today);
      end.setDate(end.getDate() + 6);
      return getDemoEvents(iso(today), iso(end));
    }
    return syncedProvider.getWeekEvents(today);
  },
};

/** All events between two ISO dates (inclusive), synced + wall-created. */
export function getEventsInRange(fromIso: string, toIso: string): CalendarEvent[] {
  if (isDemoMode()) return getDemoEvents(fromIso, toIso);
  const db = getDb();
  const synced = (
    db
      .prepare("SELECT id, member, title, date, start, end, location FROM synced_events WHERE date >= ? AND date <= ? ORDER BY date, start")
      .all(fromIso, toIso) as { id: string; member: MemberId; title: string; date: string; start: string | null; end: string | null; location: string | null }[]
  ).map((r) => ({
    id: r.id,
    member: r.member,
    title: r.title,
    date: r.date,
    start: r.start ?? undefined,
    end: r.end ?? undefined,
    location: r.location ?? undefined,
  }));
  const wall = (
    db
      .prepare("SELECT id, member, title, date, start, end, location, countdown FROM wall_events WHERE date >= ? AND date <= ? ORDER BY date, start")
      .all(fromIso, toIso) as WallRow[]
  ).map(mapWall);
  return [...synced, ...wall];
}
