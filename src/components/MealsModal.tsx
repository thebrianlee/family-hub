"use client";

// Meals utility — PIN-gated. Weekly dinner grid (defaults auto-fill, per-week
// overrides), rotating weekday defaults editor, and the parent grocery list.
// All text entry goes through SoftKeyboard (the wall has no keyboard).

import { useCallback, useEffect, useState } from "react";
import Modal from "./Modal";
import PinModal from "./PinModal";
import SoftKeyboard from "./SoftKeyboard";

interface WeekMeal {
  date: string;
  weekday: number;
  dayLabel: string;
  dinner: { meal: string; emoji: string; isOverride: boolean };
}

interface MealsData {
  week: WeekMeal[];
  defaults: { weekday: number; meal: string; emoji: string }[];
  grocery: { id: number; label: string; checked: number }[];
}

type Editing =
  | { type: "override"; key: string; label: string }
  | { type: "default"; key: number; label: string }
  | { type: "grocery" };

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MEAL_EMOJI = ["🍽️", "🌮", "🍕", "🍝", "🍔", "🍗", "🥘", "🍜", "🥗", "🍣", "🥞", "🌯"];

interface MealsModalProps {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}

export default function MealsModal({ open, onClose, onChanged }: MealsModalProps) {
  const [pin, setPin] = useState<string | null>(null);
  const [data, setData] = useState<MealsData | null>(null);
  const [tab, setTab] = useState<"week" | "defaults" | "grocery">("week");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [text, setText] = useState("");
  const [emoji, setEmoji] = useState("🍽️");

  const load = useCallback(() => fetch("/api/meals").then((r) => r.json()).then(setData).catch(() => {}), []);
  useEffect(() => {
    if (open && pin) load();
  }, [open, pin, load]);

  const close = () => {
    setPin(null);
    setEditing(null);
    setTab("week");
    onClose();
    onChanged();
  };

  const post = async (payload: Record<string, unknown>) => {
    const res = await fetch("/api/meals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin, ...payload }),
    });
    if (res.ok) {
      const d = await res.json();
      setData({ week: d.week, defaults: d.defaults, grocery: d.grocery });
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    if (editing.type === "grocery") {
      if (!text.trim()) return;
      await post({ action: "grocery_add", label: text.trim() });
    } else if (!text.trim()) {
      return;
    } else if (editing.type === "override") {
      await post({ action: "override", date: editing.key, meal: text.trim(), emoji });
    } else {
      await post({ action: "set_default", weekday: editing.key, meal: text.trim(), emoji });
    }
    setEditing(null);
    setText("");
    setEmoji("🍽️");
  };

  if (!open) return null;
  if (!pin) return <PinModal open onClose={onClose} onUnlock={setPin} title="Meal Plan" />;

  return (
    <Modal open onClose={close} title="🍽️ Meals" wide>
      <div className="flex flex-col gap-5 min-h-0">
        {editing ? (
          /* ---------- focused editor with keyboard ---------- */
          <div className="flex flex-col gap-4">
            <div className="eyebrow">
              {editing.type === "grocery" ? "Add grocery item" : `Dinner — ${editing.label}`}
            </div>
            <div className="flex items-center gap-4">
              <div className="flex-1 rounded-card bg-cream-sunken p-5 text-3xl font-bold min-h-[76px]">
                {text || <span className="text-ink-faint">Type it in…</span>}
              </div>
              {editing.type !== "grocery" && <span className="text-5xl">{emoji}</span>}
            </div>
            {editing.type !== "grocery" && (
              <div className="flex gap-1.5 overflow-x-auto pb-1">
                {MEAL_EMOJI.map((e) => (
                  <button
                    key={e}
                    onClick={() => setEmoji(e)}
                    className={`touch-target shrink-0 w-[68px] h-[58px] rounded-tile text-3xl ${
                      emoji === e ? "bg-ink text-cream" : "bg-cream-raised shadow-tile active:bg-cream-sunken"
                    }`}
                  >
                    {e}
                  </button>
                ))}
              </div>
            )}
            <SoftKeyboard value={text} onChange={setText} onDone={saveEdit} doneLabel="Save" />
            <button onClick={() => setEditing(null)} className="btn-soft px-8 py-3 text-xl self-center">
              Cancel
            </button>
          </div>
        ) : (
          <>
            {/* ---------- tabs ---------- */}
            <div className="flex gap-3 shrink-0">
              {(
                [
                  ["week", "This Week"],
                  ["defaults", "Weekday Defaults"],
                  ["grocery", "Grocery List"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  className={`touch-target flex-1 rounded-card py-4 text-2xl font-bold transition-colors ${
                    tab === key ? "bg-ink text-cream" : "bg-cream-sunken text-ink-soft"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="min-h-0 overflow-y-auto flex flex-col gap-3 pr-1 max-h-[calc(56vh/var(--fit,1))]">
              {tab === "week" &&
                (data?.week ?? []).map((w) => (
                  <div key={w.date} className="tile px-6 py-4 flex items-center gap-5">
                    <span className="w-[190px] shrink-0 text-2xl font-extrabold">{w.dayLabel}</span>
                    <span className="flex-1 text-3xl font-bold truncate">
                      {w.dinner.emoji} {w.dinner.meal}
                      {w.dinner.isOverride && (
                        <span className="ml-3 text-xl font-bold text-ember-deep align-middle">edited</span>
                      )}
                    </span>
                    <button
                      onClick={() => {
                        setEditing({ type: "override", key: w.date, label: w.dayLabel });
                        setText(w.dinner.meal);
                        setEmoji(w.dinner.emoji);
                      }}
                      className="btn-soft px-6 py-3 text-2xl"
                    >
                      Change
                    </button>
                    {w.dinner.isOverride && (
                      <button onClick={() => post({ action: "clear_override", date: w.date })} className="btn-soft px-5 py-3 text-2xl">
                        Reset
                      </button>
                    )}
                  </div>
                ))}

              {tab === "defaults" &&
                (data?.defaults ?? []).map((d) => (
                  <div key={d.weekday} className="tile px-6 py-4 flex items-center gap-5">
                    <span className="w-[190px] shrink-0 text-2xl font-extrabold">{WEEKDAYS[d.weekday]}</span>
                    <span className="flex-1 text-3xl font-bold truncate">
                      {d.emoji} {d.meal}
                    </span>
                    <button
                      onClick={() => {
                        setEditing({ type: "default", key: d.weekday, label: `every ${WEEKDAYS[d.weekday]}` });
                        setText(d.meal);
                        setEmoji(d.emoji);
                      }}
                      className="btn-soft px-6 py-3 text-2xl"
                    >
                      Change
                    </button>
                  </div>
                ))}

              {tab === "grocery" && (
                <>
                  <button
                    onClick={() => {
                      setEditing({ type: "grocery" });
                      setText("");
                    }}
                    className="btn-primary px-6 py-4 text-2xl self-start"
                  >
                    + Add an item
                  </button>
                  {(data?.grocery ?? []).map((g) => (
                    <div key={g.id} className="tile px-6 py-4 flex items-center gap-5">
                      <button
                        onClick={() => post({ action: "grocery_toggle", id: g.id })}
                        className={`touch-target w-14 h-14 rounded-tile text-3xl font-bold transition-colors ${
                          g.checked ? "bg-sage text-white" : "bg-cream-sunken text-ink-faint"
                        }`}
                      >
                        {g.checked ? "✓" : ""}
                      </button>
                      <span className={`flex-1 text-3xl font-bold ${g.checked ? "line-through text-ink-faint" : ""}`}>
                        {g.label}
                      </span>
                      <button onClick={() => post({ action: "grocery_delete", id: g.id })} className="btn-soft px-5 py-3 text-2xl">
                        Remove
                      </button>
                    </div>
                  ))}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
