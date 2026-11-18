"use client";

// CALENDAR — the family schedule beyond just today. Day / Week / Month, each
// navigable far forward and back. Reads live ICS feeds + wall-created events.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MonthCalendar, { isoOf, todayIso } from "@/components/MonthCalendar";
import Avatar from "@/components/Avatar";
import { useMembers } from "@/components/MembersProvider";
import { hexToRgba } from "@/lib/member-theme";
import FilterMenu, { FilterRow } from "@/components/FilterMenu";

type View = "schedule" | "day" | "week" | "month";
interface Ev {
  id: string;
  member: string;
  title: string;
  date: string;
  start?: string;
  end?: string;
  location?: string;
  countdown?: boolean;
}
interface Merged {
  key: string;
  title: string;
  date: string;
  start?: string;
  end?: string;
  location?: string;
  members: string[];
  countdown?: boolean;
}
function sleepsUntil(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  const target = new Date(y, m - 1, d);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - now.getTime()) / 86400000);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parse(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addDays(iso: string, n: number): string {
  const d = parse(iso);
  d.setDate(d.getDate() + n);
  return isoOf(d.getFullYear(), d.getMonth(), d.getDate());
}
function startOfWeek(iso: string): string {
  const d = parse(iso);
  return addDays(iso, -d.getDay());
}
function fmtTime(hhmm?: string): string {
  if (!hhmm) return "All day";
  const [h, m] = hhmm.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hr = h % 12 || 12;
  return m === 0 ? `${hr} ${ampm}` : `${hr}:${String(m).padStart(2, "0")} ${ampm}`;
}
function mins(hhmm?: string): number {
  if (!hhmm) return -1;
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Merge per-member rows of the same event into one row with member dots. */
function mergeDay(events: Ev[], date: string): Merged[] {
  const byKey = new Map<string, Merged>();
  for (const e of events.filter((x) => x.date === date)) {
    const key = `${e.title}|${e.start ?? ""}|${e.end ?? ""}`;
    const cur = byKey.get(key);
    if (cur) { cur.members.push(e.member); if (e.countdown) cur.countdown = true; }
    else byKey.set(key, { key, title: e.title, date: e.date, start: e.start, end: e.end, location: e.location, members: [e.member], countdown: e.countdown });
  }
  return Array.from(byKey.values()).sort((a, b) => mins(a.start) - mins(b.start));
}

/** Photo faces, not initials — a pre-reader knows whose event it is at a glance. */
function Badges({ members, size = 32 }: { members: string[]; size?: number }) {
  return (
    <span className="flex -space-x-2 shrink-0">
      {members.map((m) => (
        <Avatar key={m} member={m} size={size} />
      ))}
    </span>
  );
}
/** Single-owner events tint to that person's color; shared events stay neutral. */
function usePillStyle() {
  const { memberOf } = useMembers();
  return (members: string[]) =>
    members.length === 1 ? { backgroundColor: hexToRgba(memberOf(members[0]).color, 0.22) } : undefined;
}

export default function CalendarPage() {
  const { rowOrder, memberOf } = useMembers();
  const pillStyle = usePillStyle();
  const [view, setView] = useState<View>("day");
  const [anchor, setAnchor] = useState<string>(todayIso());
  // Day rollover on a long-lived kiosk: if the wall was left on "today",
  // follow the new day at midnight (a manually navigated anchor stays put).
  const todayRef = useRef(todayIso());
  useEffect(() => {
    const t = setInterval(() => {
      const now = todayIso();
      if (now !== todayRef.current) {
        setAnchor((a) => (a === todayRef.current ? now : a));
        todayRef.current = now;
      }
    }, 60_000);
    return () => clearInterval(t);
  }, []);
  const [events, setEvents] = useState<Ev[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const shownEvents = useMemo(() => events.filter((e) => !hidden.includes(e.member)), [events, hidden]);
  const filterRows: FilterRow[] = rowOrder.map(({ id: m, name, color }) => ({
    key: m,
    label: name,
    color,
    on: !hidden.includes(m),
    onToggle: () => setHidden((h) => (h.includes(m) ? h.filter((x) => x !== m) : [...h, m])),
  }));
  const range = useMemo(() => {
    if (view === "schedule") return [todayIso(), addDays(todayIso(), 30)];
    if (view === "day") return [anchor, anchor];
    if (view === "week") {
      const s = startOfWeek(anchor);
      return [s, addDays(s, 6)];
    }
    const d = parse(anchor);
    const first = isoOf(d.getFullYear(), d.getMonth(), 1);
    const last = isoOf(d.getFullYear(), d.getMonth(), new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate());
    return [first, last];
  }, [view, anchor]);

  const load = useCallback(() => {
    fetch(`/api/calendar?from=${range[0]}&to=${range[1]}`)
      .then((r) => r.json())
      .then((d) => setEvents(d.events ?? []))
      .catch(() => {});
  }, [range]);
  useEffect(() => {
    load();
    window.addEventListener("sproutwall:datachanged", load);
    return () => window.removeEventListener("sproutwall:datachanged", load);
  }, [load]);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const v = p.get("view");
    if (v === "schedule" || v === "day" || v === "week" || v === "month") setView(v);
    const d = p.get("d");
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) setAnchor(d);
  }, []);

  const step = (dir: number) => {
    if (view === "day") setAnchor(addDays(anchor, dir));
    else if (view === "week") setAnchor(addDays(anchor, dir * 7));
    else {
      const d = parse(anchor);
      setAnchor(isoOf(d.getFullYear(), d.getMonth() + dir, 1));
    }
  };

  const title = useMemo(() => {
    const d = parse(anchor);
    if (view === "schedule") return "Coming up";
    if (view === "day") return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    if (view === "week") {
      const s = parse(startOfWeek(anchor));
      const e = parse(addDays(startOfWeek(anchor), 6));
      return `${MONTHS[s.getMonth()]} ${s.getDate()} – ${MONTHS[e.getMonth()]} ${e.getDate()}`;
    }
    return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }, [view, anchor]);

  const dots = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const e of shownEvents) {
      (m[e.date] ??= []);
      const c = memberOf(e.member).color;
      if (!m[e.date].includes(c)) m[e.date].push(c);
    }
    return m;
  }, [shownEvents, memberOf]);

  return (
    <div className="h-full flex flex-col gap-5 min-h-0">
      <header className="flex items-center justify-between shrink-0">
        <div>
          <div className="eyebrow mb-1">Calendar</div>
          <h1 className="text-4xl font-extrabold tracking-tight">{title}</h1>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <button
              onClick={() => setFilterOpen((o) => !o)}
              className={`touch-target rounded-card px-5 py-2.5 text-xl font-extrabold shadow-tile ${hidden.length ? "bg-ink text-cream" : "bg-cream-raised text-ink-soft"}`}
            >
              Filter{hidden.length ? ` · ${rowOrder.filter((m) => !hidden.includes(m.id)).length}` : ""}
            </button>
            <FilterMenu open={filterOpen} onClose={() => setFilterOpen(false)} rows={filterRows} />
          </div>
          <div className="flex gap-1.5 rounded-card bg-cream-sunken p-1.5 shadow-tile">
            {(["schedule", "day", "week", "month"] as View[]).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`touch-target rounded-tile px-5 py-2.5 text-xl font-extrabold capitalize ${view === v ? "bg-ink text-cream shadow-tile" : "text-ink-soft active:bg-cream-line"}`}
              >
                {v === "schedule" ? "List" : v}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="flex items-center gap-3 shrink-0">
        <button onClick={() => step(-1)} className="touch-target w-14 h-14 rounded-card bg-cream-raised shadow-tile text-3xl font-bold active:bg-cream-sunken">‹</button>
        <button onClick={() => setAnchor(todayIso())} className="touch-target rounded-card bg-cream-raised shadow-tile px-6 py-3 text-2xl font-extrabold active:bg-cream-sunken">Today</button>
        <button onClick={() => step(1)} className="touch-target w-14 h-14 rounded-card bg-cream-raised shadow-tile text-3xl font-bold active:bg-cream-sunken">›</button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-4">
        {view === "schedule" && (
          <div className="flex flex-col gap-4">
            {(() => {
              const seen = new Set<string>();
              const cds = shownEvents
                .filter((e) => e.countdown && e.date >= todayIso())
                .sort((a, b) => a.date.localeCompare(b.date))
                .filter((e) => { const k = e.title + e.date; if (seen.has(k)) return false; seen.add(k); return true; });
              if (!cds.length) return null;
              return (
                <div className="flex gap-3 overflow-x-auto pb-1 shrink-0">
                  {cds.map((e) => {
                    const n = sleepsUntil(e.date);
                    return (
                      <div key={e.id} className="card bg-ember-soft px-6 py-4 shrink-0 text-center w-[200px]">
                        <div className="text-5xl font-extrabold text-ember-deep tabular-nums leading-none">{n <= 0 ? "🎉" : n}</div>
                        <div className="text-base font-bold text-ember-deep">{n <= 0 ? "Today!" : n === 1 ? "1 sleep" : `${n} sleeps`}</div>
                        <div className="text-xl font-extrabold mt-1 truncate">{e.title}</div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
            {Array.from({ length: 31 }, (_, i) => addDays(todayIso(), i)).map((iso) => {
              const merged = mergeDay(shownEvents, iso);
              if (!merged.length) return null;
              const d = parse(iso);
              const isToday = iso === todayIso();
              return (
                <div key={iso}>
                  <div className={`text-2xl font-extrabold mb-2 ${isToday ? "text-ember-deep" : ""}`}>
                    {isToday ? "Today" : d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}
                  </div>
                  <div className="flex flex-col gap-2">
                    {merged.map((m) => (
                      <div key={m.key} className="card px-6 py-4 flex items-center gap-4" style={pillStyle(m.members)}>
                        <span className="shrink-0 w-[104px] text-xl font-extrabold tabular-nums text-ink-soft">{m.start ? fmtTime(m.start) : "All day"}</span>
                        <Badges members={m.members} size={36} />
                        <span className="flex-1 min-w-0 truncate text-2xl font-extrabold">{m.title}</span>
                        {m.countdown && <span className="shrink-0 rounded-full bg-ember-soft px-3 py-1 text-lg font-extrabold text-ember-deep">⏳ {sleepsUntil(m.date)}d</span>}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
            {shownEvents.filter((e) => e.date >= todayIso()).length === 0 && (
              <div className="card px-8 py-12 text-center text-3xl font-bold text-ink-faint">Nothing coming up.</div>
            )}
          </div>
        )}
        {view === "day" && <DayView merged={mergeDay(shownEvents, anchor)} isToday={anchor === todayIso()} />}
        {view === "week" && (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i)).map((iso) => {
              const day = parse(iso);
              const merged = mergeDay(shownEvents, iso);
              const isToday = iso === todayIso();
              const past = iso < todayIso();
              return (
                <div key={iso} className={`card px-6 py-4 ${isToday ? "bg-ember-soft" : ""} ${past ? "opacity-45" : ""}`}>
                  <div className="flex items-baseline gap-3 mb-2">
                    <span className={`text-2xl font-extrabold ${isToday ? "text-ember-deep" : ""}`}>
                      {day.toLocaleDateString("en-US", { weekday: "long" })}
                    </span>
                    <span className="text-xl font-bold text-ink-faint">{MONTHS[day.getMonth()]} {day.getDate()}</span>
                  </div>
                  {merged.length === 0 ? (
                    <div className="text-xl font-bold text-ink-faint">—</div>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      {merged.map((m) => (
                        <div key={m.key} className="flex items-center gap-2.5 min-w-0 rounded-tile px-2.5 py-1.5" style={pillStyle(m.members)}>
                          <span className="shrink-0 w-[74px] text-base font-extrabold tabular-nums text-ink-faint">{m.start ? fmtTime(m.start) : "All day"}</span>
                          <Badges members={m.members} size={28} />
                          <span className="text-lg font-bold truncate">{m.title}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {view === "month" && (
          <MonthCalendar
            year={parse(anchor).getFullYear()}
            month={parse(anchor).getMonth()}
            onMonthChange={(y, mo) => setAnchor(isoOf(y, mo, 1))}
            selected={null}
            onSelect={(iso) => { setAnchor(iso); setView("day"); }}
            dots={dots}
            hideHeader
          />
        )}
      </div>
    </div>
  );
}

function DayView({ merged, isToday }: { merged: Merged[]; isToday: boolean }) {
  const { memberOf } = useMembers();
  const pillStyle = usePillStyle();
  const allDay = merged.filter((m) => !m.start);
  const timed = merged.filter((m) => m.start);
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const nextIdx = isToday ? timed.findIndex((m) => mins(m.start) >= nowMin) : -1;
  if (merged.length === 0) {
    return <div className="card px-8 py-12 text-center text-3xl font-bold text-ink-faint">Nothing scheduled — a free day! 🎈</div>;
  }
  return (
    <div className="flex flex-col gap-3">
      {allDay.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {allDay.map((m) => (
            <span key={m.key} className="rounded-full px-5 py-2.5 text-2xl font-bold text-ink flex items-center gap-3" style={pillStyle(m.members) ?? { backgroundColor: "var(--cream-sunken, #F2EBE0)" }}>
              <Badges members={m.members} size={30} /> {m.title}
            </span>
          ))}
        </div>
      )}
      {timed.map((m, i) => {
        const past = isToday && mins(m.start) < nowMin;
        const isNext = i === nextIdx;
        return (
          <div key={m.key} className={`card px-7 py-6 flex items-center gap-6 ${past ? "opacity-55" : ""}`} style={pillStyle(m.members)}>
            <span className="shrink-0 w-[150px] flex items-center justify-center gap-2">
              {past && <span className="text-3xl leading-none">✓</span>}
              <span className="text-2xl font-extrabold tabular-nums text-ink-soft">{fmtTime(m.start)}</span>
            </span>
            <Badges members={m.members} size={64} />
            <span className="flex-1 min-w-0">
              <span className="block text-4xl font-extrabold truncate leading-tight">{m.title}</span>
              <span className="block text-2xl font-bold text-ink-faint mt-1">
                {m.members.map((x) => memberOf(x).name).join(", ")}
                {m.location ? ` · ${m.location}` : ""}
              </span>
            </span>
            {isNext && <span className="shrink-0 rounded-full bg-ember px-4 py-1.5 text-xl font-extrabold text-white">NEXT</span>}
          </div>
        );
      })}
    </div>
  );
}
