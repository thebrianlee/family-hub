"use client";

// TODAY — the family dashboard, first thing the wall shows. One calm page that
// answers a kid's three questions (what do I do, where is everyone, what's for
// dinner) and gives parents a Hearth-style Family Rhythm pulse. Everything taps
// through to its own tab; nothing is editable here. A module that is switched
// off (Settings → Modules) leaves its fields out of /api/today, and its slot
// isn't shown. An answer read at an older module revision than the one shown
// is dropped whole, and every module's slot also needs isOn(), so a late
// answer can't bring back a module that has been switched off.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { STATUS_EMOJI, PARENT_STATUSES, ParentId, ParentStatus } from "@/lib/family";
import { useMembers } from "@/components/MembersProvider";
import { todayAnswerAction, useModules, type TabInfo } from "@/components/ModulesProvider";
import Avatar from "@/components/Avatar";
import Modal from "@/components/Modal";
import PinModal from "@/components/PinModal";
import { MEAL_TYPES } from "@/lib/meals";

interface Ev { id: string; member: string; title: string; date: string; start?: string; end?: string; location?: string; }
interface Merged { key: string; title: string; start?: string; members: string[]; }
// done/total come with Routines, earnedToday with Points & jar.
interface KidSnap { kid: string; done?: number; total?: number; mood: string | null; earnedToday?: number; }
interface Rhythm { score: number; label: string; dims: { key: string; label: string; emoji: string; pct: number }[]; }
interface Rule { id: number; text: string; sort: number; emoji: string; }
interface KidQuestion { id: number; kid: string; question: string; answer: string; created_at: string; }
interface MealCell { name: string; emoji: string; }
// Optional fields belong to a module and are missing while it is switched off.
interface Today {
  events?: Ev[];
  weather: { temp: number; hi: number; lo: number; emoji: string; label: string } | null;
  statuses: Record<string, ParentStatus>;
  balances?: Record<string, number>;
  spark?: { kind: string; text: string; attribution?: string; label: string };
  rhythm?: Rhythm;
  rules: Rule[];
  kids: KidSnap[];
  meals?: { slots: Record<string, MealCell | null> } | null;
  greeting?: string;
  tabs?: TabInfo[];
  modules?: string[];
  modulesRev?: number;
}

const MOOD_EMOJI: Record<string, string> = { great: "😄", good: "🙂", ok: "😐", sad: "😢", mad: "😠" };

function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
function mergeToday(events: Ev[]): Merged[] {
  const byKey = new Map<string, Merged>();
  for (const e of events.filter((x) => x.date === isoToday())) {
    const key = `${e.title}|${e.start ?? ""}`;
    const cur = byKey.get(key);
    if (cur) cur.members.push(e.member);
    else byKey.set(key, { key, title: e.title, start: e.start, members: [e.member] });
  }
  return Array.from(byKey.values()).sort((a, b) => mins(a.start) - mins(b.start));
}
function whatToWear(temp: number, label: string): string {
  const l = label.toLowerCase();
  if (/rain|shower|drizzle|storm/.test(l)) return "grab a raincoat ☔️";
  if (/snow|sleet/.test(l)) return "bundle up ❄️";
  if (temp >= 82) return "shorts + water 💧";
  if (temp >= 68) return "light layers 😎";
  if (temp >= 52) return "bring a jacket 🧥";
  return "warm coat 🧤";
}
function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function Clock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="text-7xl leading-none font-extrabold tabular-nums tracking-tight text-right">
      {now ? now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : " "}
    </div>
  );
}

/** Avatar wrapped in an SVG progress ring — a kid's day at a glance. */
function ProgressRing({ member, pct, color, size = 132 }: { member: string; pct: number; color: string; size?: number }) {
  const stroke = 10;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="absolute inset-0 -rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--cream-sunken,#F2EBE0)" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - pct)}
          className="transition-all duration-700"
        />
      </svg>
      <div className="absolute" style={{ inset: stroke + 4 }}>
        <Avatar member={member} size={size - 2 * (stroke + 4)} />
      </div>
    </div>
  );
}

/** Half-donut gauge for the family score. */
function RhythmGauge({ score, label }: { score: number; label: string }) {
  const r = 84, stroke = 16;
  const c = Math.PI * r; // half circumference
  const color = score >= 80 ? "#7FA576" : score >= 50 ? "#6E9BBD" : "#D9A254";
  return (
    <div className="relative w-[200px] shrink-0" style={{ height: 118 }}>
      <svg width={200} height={118} viewBox="0 0 200 118">
        <path d={`M ${100 - r} 108 A ${r} ${r} 0 0 1 ${100 + r} 108`} fill="none" stroke="var(--cream-sunken,#F2EBE0)" strokeWidth={stroke} strokeLinecap="round" />
        <path
          d={`M ${100 - r} 108 A ${r} ${r} 0 0 1 ${100 + r} 108`} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - score / 100)} className="transition-all duration-1000"
        />
      </svg>
      <div className="absolute inset-x-0 bottom-0 text-center">
        <div className="text-5xl font-extrabold tabular-nums leading-none" style={{ color }}>{score}</div>
        <div className="text-lg font-bold text-ink-soft">{label}</div>
      </div>
    </div>
  );
}

export default function TodayPage() {
  const router = useRouter();
  const { kids, parents, memberOf } = useMembers();
  const { isOn, rev, syncModules } = useModules();
  const [t, setT] = useState<Today | null>(null);
  // Parent status editing: PIN, then picker (carried over from the old root view).
  const [pinFor, setPinFor] = useState<ParentId | null>(null);
  const [statusFor, setStatusFor] = useState<ParentId | null>(null);
  const [pin, setPin] = useState("");
  // The newest module revision this page knows: the provider's, or that of an
  // answer it has just taken (the provider catches up on the next render).
  const revShown = useRef(rev);
  useEffect(() => {
    revShown.current = Math.max(revShown.current, rev);
  }, [rev]);
  // An answer that lands after this page was left is not used at all: it
  // would hand its module state to the screen now shown.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const show = useCallback(
    (d: Today, revAtStart: number) => {
      if (!mounted.current) return;
      const action = todayAnswerAction(revAtStart, revShown.current, d.modulesRev);
      // The database was replaced (restore): start over from the server.
      if (action === "reload") return window.location.reload();
      // Read before a newer module state: keep what is shown, take nothing.
      if (action === "drop" || typeof d.modulesRev !== "number") return;
      revShown.current = d.modulesRev;
      setT(d);
      if (Array.isArray(d.tabs) && Array.isArray(d.modules)) {
        // The provider's rule: a module switched off reloads the page.
        syncModules({ rev: d.modulesRev, modules: d.modules, tabs: d.tabs }, revAtStart);
      }
    },
    [syncModules]
  );
  useEffect(() => {
    const f = () => {
      const revAtStart = revShown.current;
      return fetch("/api/today")
        .then((r) => r.json())
        .then((d: Today) => show(d, revAtStart))
        .catch(() => {});
    };
    f();
    const iv = setInterval(f, 5 * 60_000);
    window.addEventListener("sproutwall:datachanged", f);
    return () => { clearInterval(iv); window.removeEventListener("sproutwall:datachanged", f); };
  }, [show]);
  const setStatus = async (status: ParentStatus) => {
    if (!statusFor) return;
    await fetch("/api/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin, member: statusFor, status }),
    });
    setStatusFor(null);
    setPin("");
    const revAtStart = revShown.current;
    fetch("/api/today")
      .then((r) => r.json())
      .then((d: Today) => show(d, revAtStart))
      .catch(() => {});
  };

  const [rulesOpen, setRulesOpen] = useState(false);
  // Recent questions feed the Curiosity card; asking lives on the /ask tab.
  const askOn = isOn("ask");
  const [questions, setQuestions] = useState<KidQuestion[]>([]);
  useEffect(() => {
    if (!askOn) {
      setQuestions([]);
      return;
    }
    fetch("/api/ask").then((r) => r.json()).then((d) => setQuestions(d.questions ?? [])).catch(() => {});
  }, [askOn]);

  // A module's slots, cards and links show only while it is on and the answer
  // carries its field, so neither an older answer nor an older module state
  // alone can show a module that is off.
  const routinesOn = isOn("routines");
  const showPlan = isOn("calendar") && t?.events !== undefined;
  const showMeals = isOn("meals") && t?.meals !== undefined;
  const showRings = routinesOn && t?.rhythm !== undefined;
  const rhythm = routinesOn ? t?.rhythm : undefined;
  const balances = isOn("rewards") ? t?.balances : undefined;
  const spark = askOn ? t?.spark : undefined;

  const today = new Date();
  const merged = t?.events ? mergeToday(t.events) : [];
  const nowMin = today.getHours() * 60 + today.getMinutes();
  const nextIdx = merged.findIndex((m) => mins(m.start) >= nowMin);

  return (
    <div className="h-full flex flex-col gap-4 min-h-0">
      {/* Greeting + clock + weather */}
      <header className="flex items-start justify-between shrink-0">
        <div>
          <div className="eyebrow mb-1">{today.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</div>
          <h1 className="text-5xl font-extrabold tracking-tight">{greeting()}{t?.greeting ? `, ${t.greeting}` : ""} ☀️</h1>
        </div>
        <div className="flex flex-col items-end gap-2.5">
          <Clock />
          {t?.weather && (
            <div className="tile px-5 py-2.5 text-xl font-bold text-ink-soft flex items-center gap-2.5">
              <span className="text-2xl">{t.weather.emoji}</span>
              <span className="text-ink text-2xl font-extrabold">{t.weather.temp}°</span>
              <span>{whatToWear(t.weather.temp, t.weather.label)}</span>
              <span className="text-lg text-ink-faint tabular-nums">H {t.weather.hi}° · L {t.weather.lo}°</span>
            </div>
          )}
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-7">
        {/* Family Rules — small collapsed pill; tap for the emoji-tile grid */}
        {t?.rules && t.rules.length > 0 && (
          <button
            onClick={() => setRulesOpen(true)}
            className="tile shrink-0 self-start flex items-center gap-3 px-6 py-3 active:bg-cream-sunken"
          >
            <span className="text-3xl">📜</span>
            <span className="text-2xl font-extrabold">Family Rules</span>
            <span className="text-xl font-bold text-ink-faint">→</span>
          </button>
        )}

        {/* Family Rhythm — the weekly pulse (Hearth's four dimensions), up top */}
        {rhythm && (
          <div className="card px-8 py-6 flex items-center gap-8 shrink-0">
            <RhythmGauge score={rhythm.score} label={rhythm.label} />
            <div className="flex-1 grid grid-cols-2 gap-x-10 gap-y-4">
              {rhythm.dims.map((d) => (
                <div key={d.key}>
                  <div className="flex items-center justify-between text-xl font-bold text-ink-soft mb-1.5">
                    <span>{d.emoji} {d.label}</span>
                    <span className="tabular-nums text-ink-faint">{d.pct}%</span>
                  </div>
                  <div className="h-3.5 rounded-full bg-cream-sunken overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-700 bg-parent" style={{ width: `${d.pct}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Kids — big faces with progress rings (Routines). Tap → Routines. */}
        <div className="grid gap-5 shrink-0" style={{ gridTemplateColumns: `repeat(${Math.max(1, Math.min(kids.length, 4))}, minmax(0, 1fr))` }}>
          {kids.map((k) => {
            const snap = t?.kids.find((s) => s.kid === k.id);
            const done = snap?.done ?? 0;
            const total = snap?.total ?? 0;
            const pct = total > 0 ? done / total : 0;
            const line = [
              showRings ? (snap?.total !== undefined ? `${done}/${total}` : "…") : null,
              balances ? `⭐${balances[k.id] ?? 0}` : null,
            ].filter(Boolean);
            return (
              <button
                key={k.id}
                onClick={showRings ? () => router.push("/my-day") : undefined}
                disabled={!showRings}
                className="card p-6 flex flex-col items-center gap-2.5 active:bg-cream-sunken"
              >
                <div className="relative">
                  {showRings ? (
                    <ProgressRing member={k.id} pct={pct} color={k.theme.fill} size={156} />
                  ) : (
                    <Avatar member={k.id} size={156} />
                  )}
                  {snap?.mood && <span className="absolute -bottom-1 -right-1 text-5xl">{MOOD_EMOJI[snap.mood]}</span>}
                </div>
                <div className={`text-3xl font-extrabold ${k.theme.textDeep}`}>{k.name}</div>
                {line.length > 0 && <div className="text-xl font-bold text-ink-soft tabular-nums">{line.join(" · ")}</div>}
              </button>
            );
          })}
        </div>

        {/* Today's plan — tap → Calendar */}
        {showPlan && (
        <div className="shrink-0">
          <div className="eyebrow mb-2">Today&apos;s plan</div>
          {merged.length === 0 ? (
            <div className="card px-7 py-6 text-2xl font-bold text-ink-faint">Nothing scheduled — a free day!</div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {merged.slice(0, 6).map((m, i) => {
                const past = mins(m.start) >= 0 && mins(m.start) < nowMin;
                return (
                  <button key={m.key} onClick={() => router.push("/calendar")} className={`card px-6 py-5 flex items-center gap-5 text-left active:bg-cream-sunken ${past ? "opacity-55" : ""}`}>
                    <span className="shrink-0 w-[118px] text-2xl font-extrabold tabular-nums text-ink-soft">{fmtTime(m.start)}</span>
                    <span className="flex -space-x-2 shrink-0">
                      {m.members.map((mem) => <Avatar key={mem} member={mem} size={52} />)}
                    </span>
                    <span className="flex-1 min-w-0 truncate text-3xl font-extrabold">{m.title}</span>
                    {i === nextIdx && <span className="shrink-0 rounded-full bg-ember px-3.5 py-1.5 text-xl font-extrabold text-white">NEXT</span>}
                    {past && <span className="shrink-0 text-3xl">✓</span>}
                  </button>
                );
              })}
              {merged.length > 6 && (
                <button onClick={() => router.push("/calendar")} className="text-xl font-bold text-ink-faint py-1">+ {merged.length - 6} more →</button>
              )}
            </div>
          )}
        </div>
        )}

        {/* Meals today — tap → Meals */}
        {showMeals && (
        <div className="shrink-0">
          <div className="eyebrow mb-2">Today&apos;s meals</div>
          <div className="grid grid-cols-4 gap-4">
            {MEAL_TYPES.map((mt) => {
              const cell = t?.meals?.slots[mt.key] ?? null;
              return (
                <button key={mt.key} onClick={() => router.push("/meals")} className="card px-4 py-6 flex flex-col items-center gap-1.5 text-center active:bg-cream-sunken" style={{ background: cell ? mt.tint : undefined }}>
                  <span className="text-lg font-extrabold" style={{ color: mt.color }}>{mt.label}</span>
                  <span className="text-5xl leading-none">{cell?.emoji ?? "＋"}</span>
                  <span className="text-xl font-bold leading-tight line-clamp-2">{cell?.name ?? "—"}</span>
                </button>
              );
            })}
          </div>
        </div>
        )}

        {/* Curiosity — what the kids have been asking. Tap → the Ask tab. */}
        {askOn && questions.length > 0 && (
          <button onClick={() => router.push("/ask")} className="card px-7 py-5 text-left active:bg-cream-sunken shrink-0">
            <div className="flex items-center justify-between mb-3">
              <div className="eyebrow">💡 Curiosity — what we&apos;ve asked</div>
              <span className="text-lg font-bold text-ink-faint">ask something →</span>
            </div>
            <div className="flex flex-col gap-3">
              {questions.slice(0, 3).map((q) => (
                <div key={q.id} className="flex items-start gap-3 min-w-0">
                  <Avatar member={q.kid} size={40} />
                  <div className="min-w-0 flex-1">
                    <div className="text-2xl font-extrabold leading-tight truncate">{q.question}</div>
                    <div className="text-lg font-bold text-ink-faint truncate">{q.answer}</div>
                  </div>
                </div>
              ))}
            </div>
          </button>
        )}

        {/* Spark + where the parents are */}
        <div className="flex gap-4 shrink-0 pb-1">
          {spark && (
            <div className="card flex-1 px-8 py-6">
              <div className="eyebrow mb-2">✨ {spark.label}</div>
              <div className="text-3xl font-extrabold leading-snug">
                {spark.kind === "quote" ? `“${spark.text}”` : spark.text}
              </div>
              {spark.attribution && <div className="mt-2 text-xl font-bold text-ink-soft">— {spark.attribution}</div>}
            </div>
          )}
          <div className="card px-6 py-5 flex flex-col justify-center gap-3 shrink-0">
            {parents.map((p) => {
              const st = t?.statuses[p.id];
              return (
                <button key={p.id} onClick={() => setPinFor(p.id)} className="flex items-center gap-3 text-left active:opacity-80">
                  <Avatar member={p.id} size={44} />
                  <span className="text-xl font-extrabold">{p.name}</span>
                  <span className="text-xl font-bold text-ink-soft">{st ? `${STATUS_EMOJI[st]} ${st}` : "…"}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Family Rules — emoji tiles, same style as the Rewards menu */}
      <Modal open={rulesOpen} onClose={() => setRulesOpen(false)} title="Family Rules" wide>
        <div className="flex flex-col gap-3">
          {(t?.rules ?? []).map((r) => (
            <div key={r.id} className="tile px-6 py-4 flex items-center gap-5">
              <span className="text-4xl shrink-0">{r.emoji}</span>
              <span className="flex-1 text-3xl font-extrabold">{r.text}</span>
            </div>
          ))}
        </div>
      </Modal>

      {/* Parent status: PIN then picker */}
      <PinModal
        open={pinFor !== null}
        onClose={() => setPinFor(null)}
        onUnlock={(verifiedPin) => {
          setPin(verifiedPin);
          setStatusFor(pinFor);
          setPinFor(null);
        }}
        title="Update Status"
      />
      <Modal
        open={statusFor !== null}
        onClose={() => setStatusFor(null)}
        title={statusFor ? `Where is ${memberOf(statusFor).name}?` : ""}
      >
        <div className="grid grid-cols-2 gap-4">
          {PARENT_STATUSES.map((s) => (
            <button key={s} onClick={() => setStatus(s)} className="touch-target tile px-8 py-6 text-3xl font-bold active:bg-cream-sunken">
              {STATUS_EMOJI[s]} {s}
            </button>
          ))}
        </div>
      </Modal>
    </div>
  );
}
