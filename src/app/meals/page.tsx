"use client";

// MEALS — a calendar for food. Day / Week / Month views (like the Calendar tab).
// Week grid runs meal-types down the side (rows) × days across (columns). Tap a
// cell to set/edit that meal + optional ingredients → Add to List.

import { useCallback, useEffect, useMemo, useState } from "react";
import Modal from "@/components/Modal";
import { useModules } from "@/components/ModulesProvider";
import SoftKeyboard from "@/components/SoftKeyboard";
import FilterMenu, { FilterRow } from "@/components/FilterMenu";
import { MEAL_TYPES } from "@/lib/meals";
import { isoOf, todayIso } from "@/components/MonthCalendar";

interface Cell { name: string; emoji: string; ingredients: string[]; }
interface MealDay { date: string; dayLabel: string; isToday: boolean; slots: Record<string, Cell | null>; }
type MView = "day" | "week" | "month";

const MEAL_EMOJI = ["🍗", "🍝", "🌮", "🥘", "🍔", "🍕", "🍣", "🥗", "🍜", "🥩", "🍤", "🌯", "🍳", "🥞", "🥣", "🍽️"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DOW = ["S", "M", "T", "W", "T", "F", "S"];

function parse(iso: string) { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); }
function addDays(iso: string, n: number) { const d = parse(iso); d.setDate(d.getDate() + n); return isoOf(d.getFullYear(), d.getMonth(), d.getDate()); }
function sundayOf(iso: string) { const d = parse(iso); return addDays(iso, -d.getDay()); }

function initialView(): MView {
  if (typeof window === "undefined") return "week";
  const v = new URLSearchParams(window.location.search).get("view");
  return v === "day" || v === "month" ? v : "week";
}

export default function MealsPage() {
  // "Add to List" writes into Lists, so it goes when Lists is switched off.
  const listsOn = useModules().isOn("lists");
  const [view, setView] = useState<MView>(initialView);
  const [anchor, setAnchor] = useState(todayIso());
  const [days, setDays] = useState<MealDay[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [edit, setEdit] = useState<{ date: string; slot: string; label: string } | null>(null);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("🍽️");
  const [ingText, setIngText] = useState("");
  const [field, setField] = useState<"name" | "ing">("name");
  const [banner, setBanner] = useState<string | null>(null);

  const range = useMemo(() => {
    if (view === "day") return { from: anchor, count: 1 };
    if (view === "week") return { from: sundayOf(anchor), count: 7 };
    const d = parse(anchor);
    const first = isoOf(d.getFullYear(), d.getMonth(), 1);
    return { from: first, count: new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() };
  }, [view, anchor]);

  const load = useCallback(() => {
    fetch(`/api/meals?from=${range.from}&count=${range.count}`).then((r) => r.json()).then((d) => setDays(d.week ?? [])).catch(() => {});
  }, [range]);
  useEffect(() => { load(); }, [load]);

  const visibleTypes = MEAL_TYPES.filter((t) => !hidden.includes(t.key));

  const openCell = (date: string, slot: string, label: string, cell: Cell | null) => {
    setEdit({ date, slot, label }); setName(cell?.name ?? ""); setEmoji(cell?.emoji ?? "🍽️"); setIngText(cell?.ingredients.join(", ") ?? ""); setField("name");
  };
  const post = (body: Record<string, unknown>) => fetch("/api/meals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const save = async () => {
    if (!edit || !name.trim()) return;
    const ingredients = ingText.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    const res = await post({ action: "set", date: edit.date, slot: edit.slot, name: name.trim(), emoji, ingredients });
    if (res.ok) setDays((await res.json()).week ?? days); setEdit(null); load();
  };
  const clear = async () => { if (!edit) return; await post({ action: "clear", date: edit.date, slot: edit.slot }); setEdit(null); load(); };
  const addToList = async () => {
    if (!edit) return;
    const ingredients = ingText.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    if (name.trim()) await post({ action: "set", date: edit.date, slot: edit.slot, name: name.trim(), emoji, ingredients });
    const res = await post({ action: "addToList", date: edit.date, slot: edit.slot });
    const body = await res.json().catch(() => ({})); setEdit(null); setBanner(`🛒 ${body.added ?? 0} added to your List`); setTimeout(() => setBanner(null), 2600);
  };

  const step = (dir: number) => {
    if (view === "day") setAnchor(addDays(anchor, dir));
    else if (view === "week") setAnchor(addDays(anchor, dir * 7));
    else { const d = parse(anchor); setAnchor(isoOf(d.getFullYear(), d.getMonth() + dir, 1)); }
  };
  const title = useMemo(() => {
    const d = parse(anchor);
    if (view === "day") return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    if (view === "month") return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    const s = parse(sundayOf(anchor)); const e = parse(addDays(sundayOf(anchor), 6));
    return `${MONTHS[s.getMonth()].slice(0, 3)} ${s.getDate()} – ${MONTHS[e.getMonth()].slice(0, 3)} ${e.getDate()}`;
  }, [view, anchor]);

  const filterRows: FilterRow[] = MEAL_TYPES.map((t) => ({ key: t.key, label: t.label, color: t.color, on: !hidden.includes(t.key), onToggle: () => setHidden((h) => (h.includes(t.key) ? h.filter((x) => x !== t.key) : [...h, t.key])) }));
  const editType = MEAL_TYPES.find((t) => t.key === edit?.slot);
  const cellStyle = (t: (typeof MEAL_TYPES)[number], filled: boolean) => (filled ? { background: t.tint } : { background: "var(--cream-raised,#FFFDF8)", boxShadow: "inset 0 0 0 2px #F2EBE0" });

  return (
    <div className="h-full flex flex-col gap-4 min-h-0">
      {banner && <div className="fixed top-14 left-1/2 -translate-x-1/2 z-50 card bg-cream-raised px-10 py-5 text-3xl font-extrabold animate-pop-in">{banner}</div>}
      <header className="flex items-center justify-between shrink-0">
        <div>
          <div className="eyebrow mb-1">Meals</div>
          <h1 className="text-4xl font-extrabold tracking-tight">{title}</h1>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <button onClick={() => setFilterOpen((o) => !o)} className={`touch-target rounded-card px-5 py-2.5 text-xl font-extrabold shadow-tile ${hidden.length ? "bg-ink text-cream" : "bg-cream-raised text-ink-soft"}`}>Filter</button>
            <FilterMenu open={filterOpen} onClose={() => setFilterOpen(false)} rows={filterRows} />
          </div>
          <div className="flex gap-1.5 rounded-card bg-cream-sunken p-1.5 shadow-tile">
            {(["day", "week", "month"] as MView[]).map((v) => (
              <button key={v} onClick={() => setView(v)} className={`touch-target rounded-tile px-5 py-2.5 text-xl font-extrabold capitalize ${view === v ? "bg-ink text-cream shadow-tile" : "text-ink-soft active:bg-cream-line"}`}>{v}</button>
            ))}
          </div>
        </div>
      </header>

      <div className="flex items-center gap-3 shrink-0">
        <button onClick={() => step(-1)} className="touch-target w-14 h-14 rounded-card bg-cream-raised shadow-tile text-3xl font-bold active:bg-cream-sunken">‹</button>
        <button onClick={() => setAnchor(todayIso())} className="touch-target rounded-card bg-cream-raised shadow-tile px-6 py-3 text-2xl font-extrabold active:bg-cream-sunken">Today</button>
        <button onClick={() => step(1)} className="touch-target w-14 h-14 rounded-card bg-cream-raised shadow-tile text-3xl font-bold active:bg-cream-sunken">›</button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {view === "week" && (
          <div className="flex flex-col gap-2">
            {/* day header row */}
            <div className="grid gap-1.5 shrink-0" style={{ gridTemplateColumns: `minmax(0,0.55fr) repeat(7, 1fr)` }}>
              <div />
              {days.map((d) => (
                <div key={d.date} className={`text-center py-1.5 ${d.isToday ? "text-ember-deep" : "text-ink-soft"}`}>
                  <div className="text-lg font-extrabold">{DOW[parse(d.date).getDay()]}</div>
                  <div className="text-sm font-bold text-ink-faint">{parse(d.date).getDate()}</div>
                </div>
              ))}
            </div>
            {/* one row per meal type */}
            {visibleTypes.map((t) => (
              <div key={t.key} className="grid gap-1.5" style={{ gridTemplateColumns: `minmax(0,0.55fr) repeat(7, 1fr)` }}>
                <div className="flex items-center px-2 rounded-tile font-extrabold text-lg" style={{ background: t.tint, color: t.color }}>{t.label}</div>
                {days.map((d) => {
                  const cell = d.slots[t.key];
                  return (
                    <button key={d.date} onClick={() => openCell(d.date, t.key, t.label, cell)} className="touch-target rounded-tile p-1.5 flex flex-col items-center justify-center gap-0.5 text-center active:scale-[0.98] min-h-[112px]" style={cellStyle(t, !!cell)}>
                      {cell ? (<><span className="text-2xl leading-none">{cell.emoji}</span><span className="text-sm font-bold leading-tight line-clamp-2" style={{ color: t.color }}>{cell.name}</span></>) : <span className="text-2xl text-ink-faint">＋</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {view === "day" && days[0] && (
          <div className="flex flex-col gap-4">
            {visibleTypes.map((t) => {
              const cell = days[0].slots[t.key];
              return (
                <button key={t.key} onClick={() => openCell(days[0].date, t.key, t.label, cell)} className="card px-7 py-6 flex items-center gap-6 text-left active:bg-cream-sunken" style={{ background: cell ? t.tint : undefined }}>
                  <span className="w-40 shrink-0 text-2xl font-extrabold" style={{ color: t.color }}>{t.label}</span>
                  {cell ? (<><span className="text-6xl">{cell.emoji}</span><span className="flex-1 text-4xl font-extrabold">{cell.name}</span></>) : <span className="flex-1 text-3xl font-bold text-ink-faint">＋ Add {t.label.toLowerCase()}</span>}
                </button>
              );
            })}
          </div>
        )}

        {view === "month" && (
          <div className="grid grid-cols-7 gap-1.5 h-full auto-rows-fr">
            {DOW.map((d, i) => (<div key={i} className="text-center text-sm font-bold text-ink-faint">{d}</div>))}
            {Array.from({ length: parse(range.from).getDay() }, (_, i) => <div key={`b${i}`} />)}
            {days.map((d) => {
              const dinner = d.slots.dinner;
              return (
                <button key={d.date} onClick={() => { setAnchor(d.date); setView("day"); }} className={`touch-target rounded-tile p-1.5 flex flex-col items-center gap-0.5 ${d.isToday ? "bg-ember-soft" : "bg-cream-raised shadow-tile"} active:bg-cream-sunken`}>
                  <span className={`text-lg font-extrabold ${d.isToday ? "text-ember-deep" : ""}`}>{parse(d.date).getDate()}</span>
                  {dinner && <span className="text-2xl leading-none">{dinner.emoji}</span>}
                  {dinner && <span className="text-xs font-bold text-ink-faint leading-tight line-clamp-2 text-center">{dinner.name}</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <Modal open={edit !== null} onClose={() => setEdit(null)} title={edit ? `${edit.label} · ${edit.date.slice(5)}` : ""} wide>
        {edit && (
          <div className="flex flex-col gap-3">
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {MEAL_EMOJI.map((e) => (<button key={e} onClick={() => setEmoji(e)} className={`touch-target shrink-0 w-[60px] h-[52px] rounded-tile text-3xl ${emoji === e ? "bg-ink text-cream" : "bg-cream-raised shadow-tile"}`}>{e}</button>))}
            </div>
            <button onClick={() => setField("name")} className={`text-left rounded-card px-5 py-4 text-2xl font-bold min-h-[64px] flex items-center gap-3 ${field === "name" ? "bg-cream-sunken ring-2 ring-ink-faint" : "bg-cream-sunken/60"}`}><span className="text-3xl">{emoji}</span>{name || <span className="text-ink-faint">Meal name…</span>}</button>
            <button onClick={() => setField("ing")} className={`text-left rounded-card px-5 py-4 text-xl font-bold min-h-[64px] ${field === "ing" ? "bg-cream-sunken ring-2 ring-ink-faint" : "bg-cream-sunken/60"}`}>{ingText ? <span className="text-ink">🛒 {ingText}</span> : <span className="text-ink-faint">Ingredients (comma-separated) — optional</span>}</button>
            <SoftKeyboard value={field === "name" ? name : ingText} onChange={field === "name" ? setName : setIngText} onDone={field === "name" ? () => setField("ing") : save} doneLabel={field === "name" ? "Next →" : "Save meal"} />
            <div className="flex gap-3 justify-center flex-wrap">
              <button onClick={save} disabled={!name.trim()} className="btn-primary px-8 py-3 text-xl disabled:opacity-40">Save</button>
              {listsOn && <button onClick={addToList} disabled={!ingText.trim()} className="btn-soft px-8 py-3 text-xl disabled:opacity-40" style={{ color: editType?.color }}>🛒 Add to List</button>}
              <button onClick={clear} className="btn-soft px-6 py-3 text-xl">Clear</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
