"use client";

// Reusable month grid. Powers the Calendar tab's month view and the ＋ Add
// date picker (so events can be scheduled any date, far out). Optional per-day
// event dots colored by member.

const DOW = ["S", "M", "T", "W", "T", "F", "S"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function isoOf(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
export function todayIso(): string {
  const d = new Date();
  return isoOf(d.getFullYear(), d.getMonth(), d.getDate());
}

interface Props {
  year: number;
  month: number; // 0-11
  onMonthChange: (year: number, month: number) => void;
  selected?: string | null;
  onSelect?: (iso: string) => void;
  dots?: Record<string, string[]>; // iso -> member colors
  compact?: boolean;
  hideHeader?: boolean; // when the parent already shows month + nav
}

export default function MonthCalendar({ year, month, onMonthChange, selected, onSelect, dots, compact, hideHeader }: Props) {
  const first = new Date(year, month, 1).getDay(); // 0=Sun
  const days = new Date(year, month + 1, 0).getDate();
  const today = todayIso();
  const cells: (number | null)[] = [];
  for (let i = 0; i < first; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const prev = () => onMonthChange(month === 0 ? year - 1 : year, month === 0 ? 11 : month - 1);
  const next = () => onMonthChange(month === 11 ? year + 1 : year, month === 11 ? 0 : month + 1);

  return (
    <div className="flex flex-col gap-2 h-full">
      {!hideHeader && (
        <div className="flex items-center justify-between">
          <button onClick={prev} className="touch-target w-12 h-12 rounded-tile bg-cream-sunken text-2xl font-bold active:bg-cream-line">‹</button>
          <div className={`font-extrabold ${compact ? "text-2xl" : "text-3xl"}`}>
            {MONTHS[month]} {year}
          </div>
          <button onClick={next} className="touch-target w-12 h-12 rounded-tile bg-cream-sunken text-2xl font-bold active:bg-cream-line">›</button>
        </div>
      )}
      <div className={`grid grid-cols-7 gap-1.5 ${hideHeader ? "flex-1 auto-rows-fr" : ""}`}>
        {DOW.map((d, i) => (
          <div key={i} className="text-center text-sm font-bold text-ink-faint py-1">{d}</div>
        ))}
        {cells.map((d, i) => {
          if (d === null) return <div key={i} />;
          const iso = isoOf(year, month, d);
          const isToday = iso === today;
          const isSel = selected === iso;
          const dd = dots?.[iso] ?? [];
          return (
            <button
              key={i}
              onClick={() => onSelect?.(iso)}
              className={`touch-target rounded-tile flex flex-col items-center justify-start gap-1 ${compact ? "h-14" : "min-h-[92px] pt-2"} ${
                isSel ? "bg-ink text-cream" : isToday ? "bg-ember-soft" : "bg-cream-raised shadow-tile"
              } active:bg-cream-sunken`}
            >
              <span className={`font-extrabold tabular-nums ${compact ? "text-xl" : "text-2xl"} ${isToday && !isSel ? "text-ember-deep" : ""}`}>{d}</span>
              {!compact && dd.length > 0 && (
                <span className="flex flex-wrap gap-1 justify-center px-1">
                  {dd.slice(0, 4).map((c, j) => (
                    <span key={j} className="w-2.5 h-2.5 rounded-full" style={{ background: isSel ? "#fff" : c }} />
                  ))}
                </span>
              )}
              {compact && dd.length > 0 && (
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: isSel ? "#fff" : dd[0] }} />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
