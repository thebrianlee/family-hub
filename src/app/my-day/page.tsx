"use client";

// MY DAY — the family's routine board. Every kid visible at once (no
// "logging in"); the day is split Morning / Afternoon / Evening and the wall
// auto-focuses the current slice. Big photo-forward tiles, instant optimistic
// taps, one inline number for tracked items, a one-tap mood per kid, and a
// whole-bucket celebration when a routine is finished. Routine/job editing is
// open (no PIN) — the wall lives in the home; the PIN stays on reward payouts.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KidId, Kid } from "@/lib/family";
import { useMembers } from "@/components/MembersProvider";
import { useModules } from "@/components/ModulesProvider";
import Avatar from "@/components/Avatar";
import Confetti from "@/components/Confetti";
import Modal from "@/components/Modal";
import Keypad from "@/components/Keypad";
import SoftKeyboard from "@/components/SoftKeyboard";
import ReadingSheet from "@/components/ReadingSheet";
import FilterMenu, { FilterRow } from "@/components/FilterMenu";
import KidRewards, { Progress, Reward, Wallet } from "@/components/KidRewards";

type Bucket = "morning" | "afternoon" | "evening";
const BUCKETS: Bucket[] = ["morning", "afternoon", "evening"];
const BUCKET_META: Record<Bucket, { label: string; from: number }> = {
  morning: { label: "Morning", from: 0 },
  afternoon: { label: "Afternoon", from: 12 },
  evening: { label: "Evening", from: 17 },
};
// Each time-of-day zone gets a tint + matching accent dot — the color does the
// delineating, no emoji needed.
const BAND_TINT: Record<string, string> = {
  morning: "rgba(217,162,84,0.10)",
  afternoon: "rgba(110,155,189,0.10)",
  evening: "rgba(94,123,134,0.12)",
  jobs: "rgba(127,165,118,0.10)",
};
const BAND_ACCENT: Record<string, string> = {
  morning: "#D9A254",
  afternoon: "#6E9BBD",
  evening: "#5E7B86",
  jobs: "#7FA576",
};

const MOODS = [
  { id: "great", emoji: "😄", label: "Great" },
  { id: "good", emoji: "🙂", label: "Good" },
  { id: "ok", emoji: "😐", label: "Okay" },
  { id: "sad", emoji: "😢", label: "Sad" },
  { id: "mad", emoji: "😠", label: "Mad" },
];
const moodEmoji = (id: string | null) => MOODS.find((m) => m.id === id)?.emoji ?? null;

const ITEM_EMOJI = ["🪥", "🛏️", "📖", "⚽", "✏️", "🧸", "👕", "🥣", "🎒", "🧹", "🐕", "🎹", "💛", "🙌", "🧺", "🚿"];

interface Item {
  id: number;
  label: string;
  emoji: string;
  points: number;
  bucket: Bucket;
  tracked: boolean;
  unit: string | null;
  metric_label: string | null;
  contribution: boolean;
  detail_kind: "reading" | "levelup" | null;
  type: "routine" | "job";
  freq: string | null;
  done: boolean;
  amount: number | null;
  streak: number;
}
interface Day {
  kid: KidId;
  buckets: Record<Bucket, Item[]>;
  jobs: Item[];
  mood: string | null;
  earnedToday: number;
}
interface WeekRow {
  id: number;
  label: string;
  emoji: string;
  type: "routine" | "job";
  bucket: Bucket;
  done: boolean[];
}
interface KidWeek {
  kid: KidId;
  dates: string[];
  rows: WeekRow[];
  streak: number;
}

interface TaskBoxPreset {
  id: number;
  label: string;
  emoji: string;
  bucket: string;
  tracked: boolean;
  type: string;
}

function currentBucket(): Bucket {
  const h = new Date().getHours();
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  return "evening";
}

export default function MyDayPage() {
  const { kids, memberOf } = useMembers();
  // Points & jar, Progress and Reading are modules of their own: when one is
  // switched off, its fetches, links and numbers are left out here.
  const { isOn } = useModules();
  const rewardsOn = isOn("rewards");
  const progressOn = isOn("progress");
  const readingOn = isOn("reading");
  const [days, setDays] = useState<Day[] | null>(null);
  const [celebrate, setCelebrate] = useState<string | null>(null);
  const [hideCompleted, setHideCompleted] = useState(false);
  const [hiddenKids, setHiddenKids] = useState<string[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [myView, setMyView] = useState<"day" | "week">("day");
  const [weeks, setWeeks] = useState<KidWeek[] | null>(null);
  const loadWeeks = useCallback(() => {
    fetch("/api/myday?week=1").then((r) => r.json()).then((d) => setWeeks(d.weeks)).catch(() => {});
  }, []);
  useEffect(() => {
    if (myView === "week") loadWeeks();
    window.addEventListener("sproutwall:datachanged", loadWeeks);
    return () => window.removeEventListener("sproutwall:datachanged", loadWeeks);
  }, [myView, loadWeeks]);
  const [moodFor, setMoodFor] = useState<KidId | null>(null);
  // Reward layer (folded in from the old Rewards tab): balance/goal/streak on each
  // kid header, tap the header for the full drill-down.
  const [all, setAll] = useState<Progress[] | null>(null);
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [drillKid, setDrillKid] = useState<KidId | null>(null);
  const loadRewards = useCallback(() => {
    if (progressOn) fetch("/api/progress").then((r) => r.json()).then((d) => setAll(d.all ?? [])).catch(() => {});
    if (rewardsOn) {
      fetch("/api/balance")
        .then((r) => r.json())
        .then((d) => {
          setRewards(d.rewards ?? []);
          setWallets(d.kids ?? []);
        })
        .catch(() => {});
    }
  }, [progressOn, rewardsOn]);
  const [trackFor, setTrackFor] = useState<{ kid: KidId; item: Item } | null>(null);
  const [trackValue, setTrackValue] = useState("");
  const [readingFor, setReadingFor] = useState<{ kid: KidId; item: Item } | null>(null);

  // routine/job editor
  const [editKid, setEditKid] = useState<KidId | null>(null);
  const [taskBox, setTaskBox] = useState<TaskBoxPreset[]>([]);
  useEffect(() => {
    fetch("/api/taskbox").then((r) => r.json()).then((d) => setTaskBox(d.items ?? [])).catch(() => {});
  }, []);
  const [nl, setNl] = useState("");
  const [ne, setNe] = useState("");
  const [nv, setNv] = useState("2");
  const [nb, setNb] = useState<Bucket>("morning");
  const [ntracked, setNtracked] = useState(false);

  const load = useCallback(() => {
    fetch("/api/myday").then((r) => r.json()).then((d) => setDays(d.days)).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    loadRewards();
    const onChange = () => { load(); loadRewards(); };
    window.addEventListener("sproutwall:datachanged", onChange);
    if (new URLSearchParams(window.location.search).get("v") === "week") setMyView("week");
    return () => window.removeEventListener("sproutwall:datachanged", onChange);
  }, [load, loadRewards]);
  // Deep-link: /my-day?read=<kid id> opens that kid's reading drill-down.
  const readParamDone = useRef(false);
  useEffect(() => {
    if (readParamDone.current || !days || !readingOn) return;
    const p = new URLSearchParams(window.location.search).get("read");
    if (!p) return;
    const day = days.find((d) => d.kid === p);
    const item = day && BUCKETS.flatMap((b) => day.buckets[b]).find((i) => i.detail_kind === "reading");
    if (item) { setReadingFor({ kid: p as KidId, item }); readParamDone.current = true; }
  }, [days, readingOn]);

  const banner = (msg: string, ms = 2600) => {
    setCelebrate(msg);
    window.clearTimeout((banner as unknown as { t?: number }).t);
    (banner as unknown as { t?: number }).t = window.setTimeout(() => setCelebrate(null), ms);
  };

  const dayFor = (kid: KidId) => days?.find((d) => d.kid === kid);

  // Optimistically mark done, then POST and reconcile.
  const commit = async (kid: KidId, item: Item, amount: number | null) => {
    setDays((prev) =>
      prev
        ? prev.map((d) =>
            d.kid === kid
              ? {
                  ...d,
                  buckets: {
                    ...d.buckets,
                    [item.bucket]: d.buckets[item.bucket].map((it) =>
                      it.id === item.id ? { ...it, done: true, amount } : it
                    ),
                  },
                }
              : d
          )
        : prev
    );
    try {
      const res = await fetch("/api/myday", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kid, templateId: item.id, amount }),
      });
      const body = await res.json();
      if (res.ok && !body.alreadyDone) {
        const name = memberOf(kid).name;
        // Points are still earned with Points & jar off, just not shown.
        const points = rewardsOn ? ` +${body.earned}${body.allDoneBonus ? ` +${body.allDoneBonus} bonus` : ""}` : "";
        if (body.bucketDone) {
          banner(`🎉 ${name} finished ${BUCKET_META[body.bucketDone as Bucket].label}!${points}`, 3400);
        } else {
          banner(rewardsOn ? `+${body.earned} for ${name}` : `✓ ${item.label}`, 1800);
        }
      }
    } finally {
      load();
      loadRewards();
    }
  };

  const tap = (kid: KidId, item: Item) => {
    // Reading drills into the book flow (even if already done, to finish a book).
    // With the Reading log off it is a plain tracked routine.
    if (item.detail_kind === "reading" && readingOn) {
      setReadingFor({ kid, item });
      return;
    }
    if (item.done) return;
    if (item.tracked) {
      setTrackFor({ kid, item });
      setTrackValue("");
      return;
    }
    commit(kid, item, null);
  };

  const saveTracked = () => {
    if (!trackFor) return;
    const n = parseFloat(trackValue);
    commit(trackFor.kid, trackFor.item, Number.isFinite(n) && n > 0 ? n : null);
    setTrackFor(null);
    setTrackValue("");
  };

  const setMood = async (kid: KidId, mood: string) => {
    setDays((prev) => (prev ? prev.map((d) => (d.kid === kid ? { ...d, mood } : d)) : prev));
    setMoodFor(null);
    await fetch("/api/myday", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "mood", kid, mood }),
    });
  };

  const editorPost = async (payload: Record<string, unknown>) => {
    if (!editKid) return;
    await fetch("/api/myday/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kid: editKid, ...payload }),
    });
    load();
  };

  const now = currentBucket();
  const shownKids = kids.filter((k) => !hiddenKids.includes(k.id));

  // One tile, used in every band; jobs show their payout, routines their detail.
  const ItemTile = ({ k, it }: { k: Kid; it: Item }) => {
    const pre = k.preReader;
    return (
      <button
        onClick={() => tap(k.id, it)}
        disabled={it.done && !(readingOn && it.detail_kind === "reading")}
        className={`touch-target shrink-0 ${pre ? "min-h-[100px]" : "min-h-[84px]"} rounded-card flex items-center gap-3.5 px-4 text-left transition-all active:scale-[0.98] ${
          it.done ? `${k.theme.bg} text-white` : "bg-cream-raised shadow-tile"
        }`}
      >
        <span className={`shrink-0 rounded-tile flex items-center justify-center ${pre ? "w-[72px] h-[72px] text-5xl" : "w-14 h-14 text-4xl"} ${it.done ? "bg-white/20" : "bg-cream-sunken"}`}>
          {it.done ? "✓" : it.emoji}
        </span>
        <span className="flex-1 min-w-0">
          <span className={`block font-extrabold leading-tight ${pre ? "text-3xl" : "text-2xl"}`}>{it.label}</span>
          {it.type === "job" ? (
            <span className={`block text-lg font-bold mt-0.5 ${it.done ? "text-white/80" : "text-ink-faint"}`}>{it.freq ?? "Job"}</span>
          ) : it.done && it.tracked && it.amount != null ? (
            <span className="block text-lg font-bold text-white/80 mt-0.5">{it.amount} {it.unit}</span>
          ) : it.detail_kind === "reading" && readingOn && !it.done ? (
            <span className="block text-lg font-bold text-ink-faint mt-0.5">tap for your book</span>
          ) : it.tracked && !it.done ? (
            <span className="block text-lg font-bold text-ink-faint mt-0.5">tap to log {it.unit}</span>
          ) : null}
        </span>
        {it.type === "job" && !it.done && rewardsOn && (
          <span className={`shrink-0 rounded-full px-3 py-1 text-lg font-extrabold ${k.theme.bgSoft} ${k.theme.text}`}>+{it.points}</span>
        )}
        {it.type !== "job" && !it.done && !pre && it.streak > 1 && (
          <span className="shrink-0 text-xl font-bold text-ink-faint">🔥{it.streak}</span>
        )}
      </button>
    );
  };

  return (
    <div className="h-full flex flex-col gap-5 min-h-0">
      {celebrate && (
        <>
          <Confetti />
          <div className="fixed top-14 left-1/2 -translate-x-1/2 z-50 card bg-cream-raised px-10 py-5 text-4xl font-extrabold animate-pop-in text-center">
            {celebrate}
          </div>
        </>
      )}

      {/* Header */}
      <header className="flex items-center justify-between shrink-0">
        <div>
          <div className="eyebrow mb-1">Routines</div>
          <h1 className="text-4xl font-extrabold tracking-tight">{myView === "week" ? "This Week" : "Today"}</h1>
        </div>
        <div className="flex items-center gap-3">
        <div className="relative">
          <button
            onClick={() => setFilterOpen((o) => !o)}
            className={`touch-target rounded-card px-5 py-2.5 text-xl font-extrabold shadow-tile ${hideCompleted || hiddenKids.length ? "bg-ink text-cream" : "bg-cream-raised text-ink-soft"}`}
          >
            Filter
          </button>
          <FilterMenu
            open={filterOpen}
            onClose={() => setFilterOpen(false)}
            rows={[
              { key: "completed", label: "Hide completed", on: hideCompleted, onToggle: () => setHideCompleted((v) => !v) },
              ...kids.map((k) => ({
                key: k.id,
                label: k.name,
                color: k.theme.fill,
                on: !hiddenKids.includes(k.id),
                onToggle: () => setHiddenKids((h) => (h.includes(k.id) ? h.filter((x) => x !== k.id) : [...h, k.id])),
              })) as FilterRow[],
            ]}
          />
        </div>
        <div className="flex gap-1.5 rounded-card bg-cream-sunken p-1.5 shadow-tile">
          {(["day", "week"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setMyView(v)}
              className={`touch-target rounded-tile px-5 py-2.5 text-xl font-extrabold capitalize ${myView === v ? "bg-ink text-cream shadow-tile" : "text-ink-soft active:bg-cream-line"}`}
            >
              {v}
            </button>
          ))}
        </div>
        </div>
      </header>

      {myView === "week" && <WeekBoard weeks={weeks} hiddenKids={hiddenKids} />}

      {/* Day view — time-of-day–major: full-width Morning/Afternoon/Evening/Jobs
          sections, each with one aligned column per kid. */}
      {myView === "day" && (
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-5">
        {/* Kids header row — identity, progress, payoff. Tap → drill-down. */}
        <div className="grid gap-5 shrink-0" style={{ gridTemplateColumns: `repeat(${shownKids.length}, 1fr)` }}>
          {shownKids.map((k) => {
            const day = dayFor(k.id);
            const allItems = day ? [...BUCKETS.flatMap((b) => day.buckets[b]), ...day.jobs] : [];
            const doneCount = allItems.filter((i) => i.done).length;
            const prog = progressOn ? all?.find((p) => p.kid === k.id) ?? null : null;
            const wallet = rewardsOn ? wallets.find((w) => w.kid === k.id) ?? null : null;
            const goalPct = wallet?.goal ? Math.min(100, Math.round((wallet.balance / wallet.goal.cost) * 100)) : 0;
            const goalReady = !!wallet?.goal && wallet.balance >= wallet.goal.cost;
            // Tap → the progress drill-down, or straight to the rewards menu
            // without Progress (KidRewards), or nothing with both off.
            const drillable = progressOn || rewardsOn;
            return (
              <div
                key={k.id}
                onClick={drillable ? () => setDrillKid(k.id) : undefined}
                className={`card ${k.theme.bgSoft} px-5 pt-4 pb-3 flex flex-col gap-3 ${drillable ? "cursor-pointer active:opacity-95" : ""}`}
              >
                <div className="flex items-center gap-3">
                  <Avatar member={k.id} size={64} />
                  <div className="flex-1 min-w-0">
                    <div className={`text-3xl font-extrabold leading-tight ${k.theme.textDeep}`}>{k.name}</div>
                    <div className="text-base font-bold text-ink-soft mb-1.5">
                      {allItems.length ? `${doneCount}/${allItems.length} done today` : "nothing here"}
                    </div>
                    {allItems.length > 0 && (
                      <div className="h-2.5 rounded-full bg-cream-raised overflow-hidden">
                        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${Math.round((doneCount / allItems.length) * 100)}%`, background: k.theme.fill }} />
                      </div>
                    )}
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); setMoodFor(k.id); }}
                    aria-label={`${k.name} mood`}
                    className="touch-target w-16 h-16 rounded-tile bg-cream-raised shadow-tile flex items-center justify-center text-4xl active:scale-95 transition-transform"
                  >
                    {moodEmoji(day?.mood ?? null) ?? "＋"}
                  </button>
                </div>
                {/* Reward strip — the payoff, visible where the work happens */}
                {drillable && (
                <div className="flex items-center gap-2.5">
                  {rewardsOn && (
                    <span className={`shrink-0 rounded-full bg-cream-raised px-3 py-1 text-xl font-extrabold ${k.theme.text}`}>⭐ {wallet?.balance ?? 0}</span>
                  )}
                  {(prog?.routineStreak ?? 0) > 0 && (
                    <span className="shrink-0 rounded-full bg-cream-raised px-3 py-1 text-xl font-extrabold text-ink-soft">🔥 {prog!.routineStreak}</span>
                  )}
                  {!rewardsOn ? null : wallet?.goal ? (
                    <span className="flex-1 min-w-0 flex items-center gap-2">
                      <span className="shrink-0 text-lg font-extrabold truncate max-w-[7rem]">{wallet.goal.emoji} {wallet.goal.label}</span>
                      <span className="flex-1 h-3 rounded-full bg-cream-raised overflow-hidden">
                        <span className="block h-full rounded-full transition-all duration-700" style={{ width: `${goalPct}%`, background: goalReady ? "#7FA576" : k.theme.fill }} />
                      </span>
                      <span className="shrink-0 text-sm font-bold text-ink-faint tabular-nums">{goalReady ? "ready!" : `${wallet.balance}/${wallet.goal.cost}`}</span>
                    </span>
                  ) : (
                    <span className="flex-1 text-right text-lg font-bold text-ink-faint truncate">🎁 pick a reward →</span>
                  )}
                </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Time-of-day sections */}
        {BUCKETS.map((bk) => {
          const perKid = shownKids.map((k) => {
            const items = dayFor(k.id)?.buckets[bk] ?? [];
            return { k, items, shown: hideCompleted ? items.filter((i) => !i.done) : items };
          });
          if (perKid.every(({ items }) => items.length === 0)) return null;
          const total = perKid.reduce((s, p) => s + p.items.length, 0);
          const done = perKid.reduce((s, p) => s + p.items.filter((i) => i.done).length, 0);
          return (
            <section key={bk} className="rounded-card p-4 shrink-0 flex flex-col gap-3" style={{ background: BAND_TINT[bk] }}>
              <div className="flex items-center gap-2.5 px-1">
                <span className="w-3 h-3 rounded-full shrink-0" style={{ background: BAND_ACCENT[bk] }} />
                <span className="text-xl font-extrabold uppercase tracking-[0.14em] text-ink-soft">{BUCKET_META[bk].label}</span>
                {now === bk && <span className="rounded-full bg-ember px-2.5 py-0.5 text-sm font-extrabold text-white">NOW</span>}
                <span className="flex-1" />
                <span className="text-lg font-bold text-ink-faint tabular-nums">{done === total ? "🎉" : `${done}/${total}`}</span>
              </div>
              <div className="grid gap-5 items-start" style={{ gridTemplateColumns: `repeat(${shownKids.length}, 1fr)` }}>
                {perKid.map(({ k, items, shown }) => (
                  <div key={k.id} className="flex flex-col gap-2.5 min-w-0">
                    {shown.map((it) => <ItemTile key={it.id} k={k} it={it} />)}
                    {items.length === 0 && (
                      <div className="rounded-card border-2 border-dashed border-cream-line min-h-[84px] flex items-center justify-center text-xl font-bold text-ink-faint/60">—</div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          );
        })}

        {/* Jobs section */}
        {shownKids.some((k) => (dayFor(k.id)?.jobs.length ?? 0) > 0) && (
          <section className="rounded-card p-4 shrink-0 flex flex-col gap-3" style={{ background: BAND_TINT.jobs }}>
            <div className="flex items-center gap-2.5 px-1">
              <span className="w-3 h-3 rounded-full shrink-0" style={{ background: BAND_ACCENT.jobs }} />
              <span className="text-xl font-extrabold uppercase tracking-[0.14em] text-ink-soft">Jobs</span>
              <span className="flex-1" />
              <span className="text-lg font-bold text-ink-faint tabular-nums">
                {shownKids.reduce((s, k) => s + (dayFor(k.id)?.jobs.filter((j) => j.done).length ?? 0), 0)}/
                {shownKids.reduce((s, k) => s + (dayFor(k.id)?.jobs.length ?? 0), 0)}
              </span>
            </div>
            <div className="grid gap-5 items-start" style={{ gridTemplateColumns: `repeat(${shownKids.length}, 1fr)` }}>
              {shownKids.map((k) => {
                const jobs = dayFor(k.id)?.jobs ?? [];
                const shown = hideCompleted ? jobs.filter((j) => !j.done) : jobs;
                return (
                  <div key={k.id} className="flex flex-col gap-2.5 min-w-0">
                    {shown.map((it) => <ItemTile key={it.id} k={k} it={it} />)}
                    {jobs.length === 0 && (
                      <div className="rounded-card border-2 border-dashed border-cream-line min-h-[84px] flex items-center justify-center text-xl font-bold text-ink-faint/60">—</div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Edit (parent) — one row, one button per kid, aligned with the columns */}
        <div className="grid gap-5 shrink-0 pb-1" style={{ gridTemplateColumns: `repeat(${shownKids.length}, 1fr)` }}>
          {shownKids.map((k) => (
            <button
              key={k.id}
              onClick={() => setEditKid(k.id)}
              className="py-2 text-lg font-bold text-ink-faint active:bg-cream-sunken rounded-card"
            >
              ⚙️ Edit {k.name}&apos;s routines &amp; jobs
            </button>
          ))}
        </div>
      </div>
      )}

      {/* Reward drill-down + menu (folded in from the old Rewards tab) */}
      <KidRewards drillKid={drillKid} onClose={() => setDrillKid(null)} all={all} rewards={rewards} wallets={wallets} reload={loadRewards} />

      {/* Mood picker */}
      <Modal open={moodFor !== null} onClose={() => setMoodFor(null)} title={moodFor ? `How is ${memberOf(moodFor).name} feeling?` : ""}>
        <div className="grid grid-cols-5 gap-3">
          {MOODS.map((m) => (
            <button
              key={m.id}
              onClick={() => moodFor && setMood(moodFor, m.id)}
              className="touch-target tile flex flex-col items-center gap-2 py-6 active:bg-cream-sunken"
            >
              <span className="text-6xl">{m.emoji}</span>
              <span className="text-xl font-bold text-ink-soft">{m.label}</span>
            </button>
          ))}
        </div>
      </Modal>

      {/* Tracked number entry */}
      <Modal
        open={trackFor !== null}
        onClose={() => setTrackFor(null)}
        title={trackFor ? `${trackFor.item.emoji} ${trackFor.item.label}` : ""}
      >
        {trackFor && (
          <div className="flex flex-col items-center gap-5">
            <div className="text-3xl font-bold text-ink-soft">How many {trackFor.item.unit}?</div>
            <Keypad value={trackValue} onChange={setTrackValue} maxLength={4} />
            <div className="flex gap-3">
              <button onClick={saveTracked} className="btn-primary px-12 py-5 text-3xl">
                {trackValue ? `Save ${trackValue} ${trackFor.item.unit}` : "Just check it off"}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Reading drill-down: current book, log minutes, start/finish */}
      <ReadingSheet
        open={readingFor !== null}
        kid={readingFor?.kid ?? null}
        templateId={readingFor?.item.id ?? null}
        unit={readingFor?.item.unit ?? "min"}
        done={readingFor?.item.done ?? false}
        onClose={() => setReadingFor(null)}
        onLogged={(msg, close) => {
          setCelebrate(msg);
          window.setTimeout(() => setCelebrate(null), 3000);
          load();
          if (close) setReadingFor(null);
        }}
      />

      {/* Routine/job editor — open, no PIN */}
      <Modal
        open={editKid !== null}
        onClose={() => setEditKid(null)}
        title={editKid ? `Edit ${memberOf(editKid).name}'s Routines & Jobs` : ""}
        wide
      >
        {editKid && (
          <EditRoutine
            day={dayFor(editKid)}
            emojiChoices={ITEM_EMOJI}
            taskBox={taskBox}
            onAddPreset={(p) =>
              editorPost({
                action: "add",
                label: p.label,
                emoji: p.emoji,
                points: 2,
                bucket: ["morning", "afternoon", "evening"].includes(p.bucket) ? p.bucket : "afternoon",
                tracked: p.tracked,
                unit: p.tracked ? "min" : null,
                type: p.type === "job" ? "job" : "routine",
              })
            }
            onRemove={(id) => editorPost({ action: "remove", id })}
            onAdd={async () => {
              if (!nl.trim() || !ne.trim()) return;
              await editorPost({
                action: "add",
                label: nl.trim(),
                emoji: ne,
                points: Number(nv || "2"),
                bucket: nb,
                tracked: ntracked,
                unit: ntracked ? "min" : null,
              });
              setNl("");
              setNe("");
              setNv("2");
              setNtracked(false);
            }}
            nl={nl}
            setNl={setNl}
            ne={ne}
            setNe={setNe}
            nv={nv}
            setNv={setNv}
            nb={nb}
            setNb={setNb}
            ntracked={ntracked}
            setNtracked={setNtracked}
          />
        )}
      </Modal>
    </div>
  );
}

// ---- Week view: a chore-chart matrix per kid ----
function WeekBoard({ weeks, hiddenKids }: { weeks: KidWeek[] | null; hiddenKids: string[] }) {
  const { memberOf } = useMembers();
  const DOW = ["S", "M", "T", "W", "T", "F", "S"];
  const todayIdx = new Date().getDay();
  const cols = "minmax(0,1.5fr) repeat(7, 1fr)";
  if (!weeks) return <div className="flex-1 flex items-center justify-center text-2xl font-bold text-ink-faint">Loading…</div>;
  return (
    <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-4">
      {weeks.filter((w) => !hiddenKids.includes(w.kid)).map((w) => {
        const k = memberOf(w.kid);
        return (
          <div key={w.kid} className="card p-5">
            <div className="flex items-center gap-3 mb-3">
              <Avatar member={w.kid} size={44} />
              <span className={`text-3xl font-extrabold ${k.theme.textDeep}`}>{k.name}</span>
              <span className="text-xl font-bold text-ink-faint">🔥 {w.streak} day streak</span>
            </div>
            <div className="grid items-center mb-1" style={{ gridTemplateColumns: cols }}>
              <div />
              {w.dates.map((d, i) => (
                <div key={i} className={`text-center text-lg font-bold ${i === todayIdx ? "text-ember-deep" : "text-ink-faint"}`}>{DOW[i]}</div>
              ))}
            </div>
            <div className="flex flex-col gap-1.5">
              {w.rows.map((r) => (
                <div key={r.id} className="grid items-center" style={{ gridTemplateColumns: cols }}>
                  <div className="flex items-center gap-2 min-w-0 pr-2">
                    <span className="text-2xl shrink-0">{r.emoji}</span>
                    <span className="text-lg font-bold truncate">{r.label}</span>
                  </div>
                  {r.done.map((done, i) => (
                    <div key={i} className={`flex justify-center py-1.5 ${i === todayIdx ? "bg-ember-soft rounded-tile" : ""}`}>
                      <span className={`w-7 h-7 rounded-full ${done ? "" : "border-2 border-cream-line"}`} style={done ? { background: k.theme.fill } : undefined} />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---- parent editor body (kept out of the main render for readability) ----
function EditRoutine(props: {
  day: Day | undefined;
  emojiChoices: string[];
  taskBox: TaskBoxPreset[];
  onAddPreset: (p: TaskBoxPreset) => void;
  onRemove: (id: number) => void;
  onAdd: () => void;
  nl: string; setNl: (s: string) => void;
  ne: string; setNe: (s: string) => void;
  nv: string; setNv: (s: string) => void;
  nb: Bucket; setNb: (b: Bucket) => void;
  ntracked: boolean; setNtracked: (b: boolean) => void;
}) {
  const { day, emojiChoices, taskBox, onAddPreset, onRemove, onAdd } = props;
  const all = useMemo(
    () => (day ? BUCKETS.flatMap((b) => day.buckets[b].map((i) => ({ ...i, bucket: b }))) : []),
    [day]
  );
  // Standard-task toggles: a preset is "on" if this kid already has an item
  // with the same label (routine or job).
  const haveByLabel = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of [...all, ...(day?.jobs ?? [])]) m.set(i.label.toLowerCase(), i.id);
    return m;
  }, [all, day]);
  return (
    <div className="flex flex-col gap-4 min-h-0 overflow-y-auto pr-1">
      {taskBox.length > 0 && (
        <div>
          <div className="eyebrow mb-2">Standard tasks — tap to add or remove</div>
          <div className="flex flex-wrap gap-2">
            {taskBox.map((p) => {
              const onId = haveByLabel.get(p.label.toLowerCase());
              return (
                <button
                  key={p.id}
                  onClick={() => (onId !== undefined ? onRemove(onId) : onAddPreset(p))}
                  className={`touch-target rounded-tile px-4 py-2.5 text-xl font-bold flex items-center gap-2 ${
                    onId !== undefined ? "bg-ink text-cream" : "bg-cream-raised text-ink-soft shadow-tile active:bg-cream-sunken"
                  }`}
                >
                  <span className="text-2xl">{p.emoji}</span>
                  {p.label}
                  {onId !== undefined && <span className="text-lg">✓</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {BUCKETS.map((b) => {
        const items = all.filter((i) => i.bucket === b);
        if (!items.length) return null;
        return (
          <div key={b}>
            <div className="eyebrow mb-2">{BUCKET_META[b].label}</div>
            <div className="flex flex-col gap-2">
              {items.map((item) => (
                <div key={item.id} className="tile px-5 py-3 flex items-center gap-4">
                  <span className="text-3xl">{item.emoji}</span>
                  <span className="flex-1 text-2xl font-bold">{item.label}</span>
                  {item.tracked && <span className="text-lg font-bold text-ink-faint uppercase">logs {item.unit}</span>}
                  <span className="text-xl font-bold text-ink-soft">+{item.points}</span>
                  <button onClick={() => onRemove(item.id)} className="btn-soft px-4 py-2 text-xl">
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {/* Jobs — helping tasks live outside the time buckets but are removable here too */}
      {day && day.jobs.length > 0 && (
        <div>
          <div className="eyebrow mb-2">Jobs</div>
          <div className="flex flex-col gap-2">
            {day.jobs.map((item) => (
              <div key={item.id} className="tile px-5 py-3 flex items-center gap-4">
                <span className="text-3xl">{item.emoji}</span>
                <span className="flex-1 text-2xl font-bold">{item.label}</span>
                {item.freq && <span className="text-lg font-bold text-ink-faint">{item.freq}</span>}
                <span className="text-xl font-bold text-ink-soft">+{item.points}</span>
                <button onClick={() => onRemove(item.id)} className="btn-soft px-4 py-2 text-xl">
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add new */}
      <div className="tile px-5 py-4 flex flex-col gap-3">
        <div className="eyebrow">Add a new item</div>
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {emojiChoices.map((e) => (
            <button
              key={e}
              onClick={() => props.setNe(e)}
              className={`touch-target shrink-0 w-[60px] h-[52px] rounded-tile text-3xl ${
                props.ne === e ? "bg-ink text-cream" : "bg-cream-raised shadow-tile active:bg-cream-sunken"
              }`}
            >
              {e}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-3xl w-12 text-center">{props.ne || "❔"}</span>
          <div className="flex-1 min-w-[180px] rounded-tile bg-cream-sunken px-4 py-3 text-2xl font-bold min-h-[56px]">
            {props.nl || <span className="text-ink-faint">New item…</span>}
          </div>
          <div className="flex rounded-tile overflow-hidden shadow-tile">
            {BUCKETS.map((b) => (
              <button
                key={b}
                onClick={() => props.setNb(b)}
                className={`touch-target px-4 py-3 text-lg font-bold ${props.nb === b ? "bg-ink text-cream" : "bg-cream-raised text-ink-soft"}`}
              >
                {{ morning: "Morn", afternoon: "Aft", evening: "Eve" }[b]}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={() => props.setNv(String(Math.max(0, Number(props.nv || "2") - 1)))} className="touch-target w-12 h-12 rounded-tile bg-cream-sunken text-2xl font-bold">−</button>
            <span className="w-12 text-center text-2xl font-extrabold tabular-nums">+{props.nv || "2"}</span>
            <button onClick={() => props.setNv(String(Math.min(20, Number(props.nv || "2") + 1)))} className="touch-target w-12 h-12 rounded-tile bg-cream-sunken text-2xl font-bold">+</button>
          </div>
          <button
            onClick={() => props.setNtracked(!props.ntracked)}
            className={`touch-target rounded-tile px-4 py-3 text-xl font-bold ${props.ntracked ? "bg-ink text-cream" : "bg-cream-raised text-ink-soft shadow-tile"}`}
          >
            {props.ntracked ? "⏱ logs minutes" : "＋ track minutes"}
          </button>
        </div>
        <SoftKeyboard value={props.nl} onChange={props.setNl} doneLabel="Add" onDone={onAdd} />
      </div>
    </div>
  );
}
