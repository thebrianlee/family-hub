"use client";

// ＋ ADD — create an Event or a Routine right on the wall, no computer.
// Events (who / when / where) land in wall_events and show on the calendar.
// Routines (which kid / bucket / days / tracked) extend the kid's My Day.
// Modeled on Skylight/Hearth's two input types.

import { useEffect, useState } from "react";
import { useMembers } from "./MembersProvider";
import Modal from "./Modal";
import SoftKeyboard from "./SoftKeyboard";
import MonthCalendar, { isoOf, todayIso } from "./MonthCalendar";

type Step = "choose" | "event" | "routine";

const DOW = ["S", "M", "T", "W", "T", "F", "S"];
const BUCKETS: { id: string; label: string; emoji: string }[] = [
  { id: "morning", label: "Morning", emoji: "🌅" },
  { id: "afternoon", label: "Afternoon", emoji: "☀️" },
  { id: "evening", label: "Evening", emoji: "🌙" },
];
const ITEM_EMOJI = ["🪥", "🛏️", "📖", "⚽", "🥍", "🎹", "🏊", "✏️", "🧸", "👕", "🧹", "💻", "🀄", "🚿", "🎨", "🧺"];

function to24(h: number, m: number, pm: boolean): string {
  let hh = h % 12;
  if (pm) hh += 12;
  return `${String(hh).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function fireChanged() {
  window.dispatchEvent(new CustomEvent("familyhub:datachanged"));
}

function TimePicker({
  h, m, pm, onH, onM, onPm,
}: { h: number; m: number; pm: boolean; onH: (n: number) => void; onM: (n: number) => void; onPm: (b: boolean) => void }) {
  const step = (cur: number, delta: number, max: number, min = 0) => {
    let n = cur + delta;
    if (n > max) n = min;
    if (n < min) n = max;
    return n;
  };
  return (
    <div className="flex items-center gap-2">
      <Stepper value={String(h)} onDown={() => onH(step(h, -1, 12, 1))} onUp={() => onH(step(h, 1, 12, 1))} />
      <span className="text-3xl font-extrabold">:</span>
      <Stepper value={String(m).padStart(2, "0")} onDown={() => onM(step(m, -5, 55))} onUp={() => onM(step(m, 5, 55))} />
      <div className="flex rounded-tile overflow-hidden shadow-tile ml-1">
        {[false, true].map((v) => (
          <button
            key={String(v)}
            onClick={() => onPm(v)}
            className={`touch-target px-4 py-3 text-2xl font-extrabold ${pm === v ? "bg-ink text-cream" : "bg-cream-raised text-ink-soft"}`}
          >
            {v ? "PM" : "AM"}
          </button>
        ))}
      </div>
    </div>
  );
}
function Stepper({ value, onUp, onDown }: { value: string; onUp: () => void; onDown: () => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <button onClick={onDown} className="touch-target w-12 h-12 rounded-tile bg-cream-sunken text-3xl font-bold active:bg-cream-line">−</button>
      <span className="w-14 text-center text-3xl font-extrabold tabular-nums">{value}</span>
      <button onClick={onUp} className="touch-target w-12 h-12 rounded-tile bg-cream-sunken text-3xl font-bold active:bg-cream-line">+</button>
    </div>
  );
}

export default function AddSheet({ open, onClose, initialStep = "choose", initialType = "routine" }: { open: boolean; onClose: () => void; initialStep?: Step; initialType?: "routine" | "job" }) {
  const { kids, rowOrder } = useMembers();
  // Everyone can be on an event: kids in their color, parents in the parent slate.
  const MEMBERS = rowOrder.map((m) => ({ id: m.id, name: m.name, color: m.theme.fill }));
  const firstKid = kids[0]?.id;
  const [step, setStep] = useState<Step>(initialStep);
  const [saving, setSaving] = useState(false);
  const [rType, setRType] = useState<"routine" | "job">(initialType);
  useEffect(() => {
    if (open) {
      setStep(initialStep);
      setRType(initialType);
    }
  }, [open, initialStep, initialType]);

  // event
  const [evMembers, setEvMembers] = useState<string[]>([]);
  const [evTitle, setEvTitle] = useState("");
  const [evDate, setEvDate] = useState(todayIso());
  const nowD = new Date();
  const [pmY, setPmY] = useState(nowD.getFullYear());
  const [pmM, setPmM] = useState(nowD.getMonth());
  const [allDay, setAllDay] = useState(false);
  const [evCountdown, setEvCountdown] = useState(false);
  const [sh, setSh] = useState(9); const [sm, setSm] = useState(0); const [spm, setSpm] = useState(false);
  const [eh, setEh] = useState(10); const [em, setEm] = useState(0); const [epm, setEpm] = useState(false);

  // routine / job
  const [rKids, setRKids] = useState<string[]>(firstKid ? [firstKid] : []);
  const [rTitle, setRTitle] = useState("");
  const [rEmoji, setREmoji] = useState("⚽");
  const [rBucket, setRBucket] = useState("afternoon");
  const [rDays, setRDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [rTracked, setRTracked] = useState(false);
  const [rValue, setRValue] = useState(3);
  const [rJobMode, setRJobMode] = useState<"once" | "repeat">("once");
  const [rJobDate, setRJobDate] = useState(todayIso());
  const [jpY, setJpY] = useState(nowD.getFullYear());
  const [jpM, setJpM] = useState(nowD.getMonth());
  const [taskBox, setTaskBox] = useState<{ id: number; label: string; emoji: string; bucket: string; tracked: boolean; type: string }[]>([]);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [saveToBox, setSaveToBox] = useState(false);
  useEffect(() => {
    fetch("/api/taskbox").then((r) => r.json()).then((d) => setTaskBox(d.items ?? [])).catch(() => {});
  }, []);

  const reset = () => {
    setStep("choose");
    setEvMembers([]); setEvTitle(""); setEvDate(todayIso()); setPmY(nowD.getFullYear()); setPmM(nowD.getMonth()); setAllDay(false); setEvCountdown(false);
    setSh(9); setSm(0); setSpm(false); setEh(10); setEm(0); setEpm(false);
    setRKids(firstKid ? [firstKid] : []); setRType("routine"); setRTitle(""); setREmoji("⚽"); setRBucket("afternoon");
    setRDays([0, 1, 2, 3, 4, 5, 6]); setRTracked(false); setRValue(3);
    setRJobMode("once"); setRJobDate(todayIso()); setJpY(nowD.getFullYear()); setJpM(nowD.getMonth());
    setPresetsOpen(false); setSaveToBox(false);
  };
  const applyPreset = (p: { label: string; emoji: string; bucket: string; tracked: boolean; type: string }) => {
    setRType(p.type === "job" ? "job" : "routine");
    setRTitle(p.label);
    setREmoji(p.emoji);
    setRBucket(p.bucket);
    setRTracked(p.tracked);
    setPresetsOpen(false);
  };
  const close = () => { reset(); onClose(); };

  const tomorrow = () => {
    const d = new Date(); d.setDate(d.getDate() + 1);
    return isoOf(d.getFullYear(), d.getMonth(), d.getDate());
  };

  const saveEvent = async () => {
    if (saving || !evMembers.length || !evTitle.trim()) return;
    setSaving(true);
    try {
      await fetch("/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add", members: evMembers, title: evTitle.trim(), date: evDate,
          start: allDay ? null : to24(sh, sm, spm),
          end: allDay ? null : to24(eh, em, epm),
          countdown: evCountdown,
        }),
      });
      fireChanged();
      close();
    } finally { setSaving(false); }
  };

  const saveRoutine = async () => {
    const isJob = rType === "job";
    if (saving || !rTitle.trim() || !rKids.length) return;
    if (rType === "routine" && !rDays.length) return;
    if (isJob && rJobMode === "repeat" && !rDays.length) return;
    setSaving(true);
    try {
      const base = {
        action: "add", label: rTitle.trim(), emoji: rEmoji, points: rValue,
        type: rType,
        saveToBox,
        ...(isJob
          ? {
              bucket: "afternoon", tracked: false,
              due_date: rJobMode === "once" ? rJobDate : null,
              days: rJobMode === "repeat" ? [...rDays].sort().join("") : "0123456",
            }
          : {
              bucket: rBucket, tracked: rTracked, unit: "min",
              days: [...rDays].sort().join(""),
            }),
      };
      // Fan out: one template per selected kid.
      for (const kid of rKids) {
        await fetch("/api/myday/templates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...base, kid }),
        });
      }
      fireChanged();
      close();
    } finally { setSaving(false); }
  };

  const title = step === "choose" ? "Add to the wall" : step === "event" ? "New event" : "New routine";

  return (
    <Modal open={open} onClose={close} title={title} wide>
      {step === "choose" && (
        <div className="grid grid-cols-2 gap-5">
          <button onClick={() => setStep("event")} className="touch-target card flex flex-col items-center gap-3 py-12 active:bg-cream-sunken">
            <span className="text-7xl">📅</span>
            <span className="text-3xl font-extrabold">Event</span>
            <span className="text-xl font-bold text-ink-faint">a game, appointment, dinner</span>
          </button>
          <button onClick={() => setStep("routine")} className="touch-target card flex flex-col items-center gap-3 py-12 active:bg-cream-sunken">
            <span className="text-7xl">✅</span>
            <span className="text-3xl font-extrabold">Routine or Job</span>
            <span className="text-xl font-bold text-ink-faint">a habit or a helping task</span>
          </button>
        </div>
      )}

      {step === "event" && (
        <div className="flex flex-col gap-5 min-h-0 overflow-y-auto pr-1">
          <div>
            <div className="eyebrow mb-2">Who&apos;s it for?</div>
            <div className="flex flex-wrap gap-3">
              {MEMBERS.map((mem) => {
                const on = evMembers.includes(mem.id);
                return (
                  <button
                    key={mem.id}
                    onClick={() => setEvMembers((p) => (on ? p.filter((x) => x !== mem.id) : [...p, mem.id]))}
                    className="touch-target rounded-card px-6 py-4 text-2xl font-extrabold shadow-tile"
                    style={on ? { background: mem.color, color: "#fff" } : { background: "var(--tw-cream-raised,#FFFDF8)", color: "#5C7078" }}
                  >
                    {mem.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="eyebrow mb-2">When?</div>
            <div className="flex gap-2 mb-3">
              {[["Today", todayIso()], ["Tomorrow", tomorrow()]].map(([label, d]) => (
                <button
                  key={label}
                  onClick={() => { setEvDate(d); const dd = new Date(d + "T00:00"); setPmY(dd.getFullYear()); setPmM(dd.getMonth()); }}
                  className={`touch-target rounded-tile px-5 py-3 text-2xl font-extrabold ${evDate === d ? "bg-ink text-cream" : "bg-cream-raised text-ink-soft shadow-tile"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <MonthCalendar year={pmY} month={pmM} onMonthChange={(y, m) => { setPmY(y); setPmM(m); }} selected={evDate} onSelect={setEvDate} compact />
          </div>

          <div className="flex items-center gap-4 flex-wrap">
            <button
              onClick={() => setAllDay((v) => !v)}
              className={`touch-target rounded-tile px-5 py-3 text-2xl font-extrabold ${allDay ? "bg-ink text-cream" : "bg-cream-raised text-ink-soft shadow-tile"}`}
            >
              {allDay ? "◉ All day" : "○ All day"}
            </button>
            <button
              onClick={() => setEvCountdown((v) => !v)}
              className={`touch-target rounded-tile px-5 py-3 text-2xl font-extrabold ${evCountdown ? "bg-ember text-white" : "bg-cream-raised text-ink-soft shadow-tile"}`}
            >
              {evCountdown ? "⏳ Countdown on" : "⏳ Countdown"}
            </button>
            {!allDay && (
              <div className="flex items-center gap-3 flex-wrap">
                <span className="eyebrow">Start</span>
                <TimePicker h={sh} m={sm} pm={spm} onH={setSh} onM={setSm} onPm={setSpm} />
                <span className="eyebrow ml-2">End</span>
                <TimePicker h={eh} m={em} pm={epm} onH={setEh} onM={setEm} onPm={setEpm} />
              </div>
            )}
          </div>

          <div>
            <div className="eyebrow mb-2">What is it?</div>
            <div className="rounded-card bg-cream-sunken px-5 py-4 text-2xl font-bold min-h-[64px] mb-3">
              {evTitle || <span className="text-ink-faint">e.g. Soccer game vs Falcons</span>}
            </div>
            <SoftKeyboard value={evTitle} onChange={setEvTitle} doneLabel={saving ? "Saving…" : "Add event"} onDone={saveEvent} />
          </div>
          <button onClick={() => setStep("choose")} className="btn-soft px-8 py-3 text-xl self-start">← Back</button>
        </div>
      )}

      {step === "routine" && (
        <div className="flex flex-col gap-4 min-h-0 overflow-y-auto pr-1">
          {/* Routine vs Job */}
          <div className="flex rounded-card overflow-hidden shadow-tile">
            {(["routine", "job"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setRType(t)}
                className={`flex-1 touch-target py-4 text-2xl font-extrabold ${rType === t ? "bg-ink text-cream" : "bg-cream-raised text-ink-soft"}`}
              >
                {t === "routine" ? "🔁 Routine" : "🧹 Job"}
              </button>
            ))}
          </div>
          <div className="text-lg font-bold text-ink-faint -mt-2">
            {rType === "routine" ? "A daily rhythm, tied to a time of day." : "A helping task on a day — earns stars, helps the family 💛"}
          </div>

          {/* Task Box presets */}
          <div>
            <button onClick={() => setPresetsOpen((o) => !o)} className="btn-soft px-5 py-3 text-xl">
              📋 {presetsOpen ? "Hide Task Box" : "Quick-add from Task Box"}
            </button>
            {presetsOpen && (
              <div className="flex flex-wrap gap-2 mt-3">
                {taskBox.map((p) => (
                  <button key={p.id} onClick={() => applyPreset(p)} className="touch-target rounded-tile bg-cream-raised shadow-tile px-4 py-2.5 text-xl font-bold flex items-center gap-2 active:bg-cream-sunken">
                    <span className="text-2xl">{p.emoji}</span>
                    {p.label}
                    {p.type === "job" && <span className="text-sm text-ink-faint">job</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Who (multi-select) */}
          <div>
            <div className="eyebrow mb-2">Who&apos;s it for?</div>
            <div className="flex flex-wrap gap-3">
              {kids.map((k) => {
                const on = rKids.includes(k.id);
                return (
                  <button
                    key={k.id}
                    onClick={() => setRKids((p) => (on ? p.filter((x) => x !== k.id) : [...p, k.id]))}
                    className={`touch-target flex-1 rounded-card py-4 text-2xl font-extrabold ${on ? `${k.theme.bg} text-white shadow-card` : `${k.theme.bgSoft} ${k.theme.text}`}`}
                  >
                    {k.name}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Emoji + title */}
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {ITEM_EMOJI.map((e) => (
              <button key={e} onClick={() => setREmoji(e)} className={`touch-target shrink-0 w-[58px] h-[52px] rounded-tile text-3xl ${rEmoji === e ? "bg-ink text-cream" : "bg-cream-raised shadow-tile"}`}>
                {e}
              </button>
            ))}
          </div>
          <div className="rounded-card bg-cream-sunken px-5 py-4 text-2xl font-bold min-h-[64px] flex items-center gap-3">
            <span className="text-3xl">{rEmoji}</span>
            {rTitle || <span className="text-ink-faint">{rType === "job" ? "e.g. Clean your room" : "e.g. Piano practice"}</span>}
          </div>

          {rType === "routine" ? (
            <div className="flex gap-6 flex-wrap">
              <div>
                <div className="eyebrow mb-2">Time of day</div>
                <div className="flex gap-2">
                  {BUCKETS.map((b) => (
                    <button key={b.id} onClick={() => setRBucket(b.id)} className={`touch-target rounded-tile px-4 py-3 text-xl font-extrabold ${rBucket === b.id ? "bg-ink text-cream" : "bg-cream-raised text-ink-soft shadow-tile"}`}>
                      {b.emoji} {b.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="eyebrow mb-2">Which days</div>
                <div className="flex gap-1.5">
                  {DOW.map((d, i) => {
                    const on = rDays.includes(i);
                    return (
                      <button key={i} onClick={() => setRDays((p) => (on ? p.filter((x) => x !== i) : [...p, i]))} className={`touch-target w-12 h-12 rounded-tile text-xl font-extrabold ${on ? "bg-ink text-cream" : "bg-cream-raised text-ink-faint shadow-tile"}`}>
                        {d}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <div className="eyebrow mb-2">Track</div>
                <button onClick={() => setRTracked((v) => !v)} className={`touch-target rounded-tile px-5 py-3 text-xl font-extrabold ${rTracked ? "bg-ink text-cream" : "bg-cream-raised text-ink-soft shadow-tile"}`}>
                  {rTracked ? "⏱ Logs minutes" : "✓ Simple check"}
                </button>
              </div>
            </div>
          ) : (
            <div>
              <div className="eyebrow mb-2">When</div>
              <div className="flex gap-2 mb-3">
                {(["once", "repeat"] as const).map((m) => (
                  <button key={m} onClick={() => setRJobMode(m)} className={`touch-target rounded-tile px-5 py-3 text-xl font-extrabold ${rJobMode === m ? "bg-ink text-cream" : "bg-cream-raised text-ink-soft shadow-tile"}`}>
                    {m === "once" ? "📅 One time" : "🔁 Repeats"}
                  </button>
                ))}
              </div>
              {rJobMode === "once" ? (
                <MonthCalendar year={jpY} month={jpM} onMonthChange={(y, m) => { setJpY(y); setJpM(m); }} selected={rJobDate} onSelect={setRJobDate} compact />
              ) : (
                <div className="flex gap-1.5">
                  {DOW.map((d, i) => {
                    const on = rDays.includes(i);
                    return (
                      <button key={i} onClick={() => setRDays((p) => (on ? p.filter((x) => x !== i) : [...p, i]))} className={`touch-target w-12 h-12 rounded-tile text-xl font-extrabold ${on ? "bg-ink text-cream" : "bg-cream-raised text-ink-faint shadow-tile"}`}>
                        {d}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-3">
            <div className="eyebrow">Stars</div>
            <button onClick={() => setRValue((v) => Math.max(1, v - 1))} className="touch-target w-12 h-12 rounded-tile bg-cream-sunken text-3xl font-bold">−</button>
            <span className="w-14 text-center text-3xl font-extrabold tabular-nums">⭐{rValue}</span>
            <button onClick={() => setRValue((v) => Math.min(20, v + 1))} className="touch-target w-12 h-12 rounded-tile bg-cream-sunken text-3xl font-bold">+</button>
            <div className="flex-1" />
            <button onClick={() => setSaveToBox((v) => !v)} className={`touch-target rounded-tile px-4 py-2.5 text-lg font-bold ${saveToBox ? "bg-ink text-cream" : "bg-cream-raised text-ink-faint shadow-tile"}`}>
              💾 Save to Task Box
            </button>
          </div>

          <SoftKeyboard value={rTitle} onChange={setRTitle} doneLabel={saving ? "Saving…" : rType === "job" ? "Add job" : "Add routine"} onDone={saveRoutine} />
          <button onClick={() => setStep("choose")} className="btn-soft px-8 py-3 text-xl self-start">← Back</button>
        </div>
      )}
    </Modal>
  );
}
