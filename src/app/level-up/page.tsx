"use client";

// LEVEL UP — per-kid progression log with full game framing: badges,
// milestone progress, sparkline trends, streaks, PB celebrations.

import { useCallback, useEffect, useState } from "react";
import { KidId } from "@/lib/family";
import { useMembers } from "@/components/MembersProvider";
import { useModules } from "@/components/ModulesProvider";
import KidPicker from "@/components/KidPicker";
import Sparkline from "@/components/Sparkline";
import Confetti from "@/components/Confetti";
import Modal from "@/components/Modal";
import Keypad from "@/components/Keypad";
import PinModal from "@/components/PinModal";
import SoftKeyboard from "@/components/SoftKeyboard";

const ACTIVITY_EMOJI = ["⚽", "🥍", "🤹", "🥅", "💪", "🎹", "🏀", "🏊", "🚴", "🎨", "♟️", "🥋", "🏃", "🎸", "📐", "🧗"];

interface ActivitySummary {
  activity: string;
  label: string;
  emoji: string;
  metric: "duration" | "count";
  unit: string;
  sessions: number;
  best: number | null;
  latest: number | null;
  totalMinutes: number;
  history: { value: number; created_at: string }[];
  nextMilestone: { target: number; progress: number } | null;
}

interface Badge {
  id: string;
  label: string;
  emoji: string;
  earned: boolean;
  progress: number;
  detail: string;
}

interface Summary {
  kid: KidId;
  streak: number;
  totalSessions: number;
  badges: Badge[];
  activities: ActivitySummary[];
}

export default function LevelUpPage() {
  // Points are still awarded with Points & jar off; only the "+N" is hidden.
  const rewardsOn = useModules().isOn("rewards");
  const { kids, memberOf } = useMembers();
  const [kid, setKid] = useState<KidId | null>(kids[0]?.id ?? null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [entry, setEntry] = useState<ActivitySummary | null>(null);
  const [value, setValue] = useState("");
  const [celebrate, setCelebrate] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmoji, setNewEmoji] = useState("🏅");
  const [newMetric, setNewMetric] = useState<"count" | "duration">("duration");
  const [removeFor, setRemoveFor] = useState<ActivitySummary | null>(null);

  const load = useCallback((k: KidId) => {
    fetch(`/api/levelup?kid=${k}`).then((r) => r.json()).then((d) => setSummary(d.summary)).catch(() => {});
  }, []);

  useEffect(() => {
    if (kid) load(kid);
  }, [kid, load]);

  const submit = async () => {
    if (!kid || !entry) return;
    const num = parseFloat(value);
    if (!Number.isFinite(num) || num <= 0) return;
    const payload =
      entry.metric === "count"
        ? { kid, activity: entry.activity, count: num }
        : { kid, activity: entry.activity, duration_min: num };
    const res = await fetch("/api/levelup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    setEntry(null);
    setValue("");
    load(kid);
    if (res.ok && body.isPersonalBest) {
      setCelebrate(`NEW PERSONAL BEST! ${num} ${entry.unit} ${entry.label}!`);
      setTimeout(() => setCelebrate(null), 4200);
    } else if (res.ok) {
      setCelebrate(rewardsOn ? `Session logged! +${body.earned} Family Bucks` : "Session logged!");
      setTimeout(() => setCelebrate(null), 2400);
    }
  };

  const theme = kid ? memberOf(kid).theme : null;
  const earnedBadges = summary?.badges.filter((b) => b.earned) ?? [];
  const nextBadge = summary?.badges.filter((b) => !b.earned).sort((a, b) => b.progress - a.progress)[0];

  return (
    <div className="h-full flex flex-col gap-6 min-h-0">
      {celebrate && (
        <>
          <Confetti />
          <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 card bg-ember-soft px-12 py-6 text-4xl font-extrabold animate-pop-in">
            🏆 {celebrate}
          </div>
        </>
      )}

      <header className="shrink-0 flex items-end justify-between">
        <div>
          <div className="eyebrow mb-2">Level Up</div>
          <h1 className="text-6xl font-extrabold tracking-tight">
            {kid ? `${memberOf(kid).name}'s Training` : "Training"}
          </h1>
        </div>
        <button
          onClick={() => {
            setAddOpen(true);
            setNewName("");
            setNewEmoji("🏅");
            setNewMetric("duration");
          }}
          className="btn-soft px-7 py-4 text-2xl"
        >
          + New Activity
        </button>
      </header>

      <KidPicker selected={kid} onSelect={setKid} />

      {/* Streak + badges strip */}
      <div className="card px-8 py-5 shrink-0 flex items-center gap-8 max-sm:flex-wrap max-sm:gap-4 max-sm:px-4">
        <div className="text-center shrink-0">
          <div className={`text-6xl font-extrabold tabular-nums ${theme?.text ?? ""}`}>🔥 {summary?.streak ?? 0}</div>
          <div className="text-xl font-bold text-ink-soft">day streak</div>
        </div>
        <div className="w-px h-20 bg-cream-line shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="eyebrow mb-2">Achievements</div>
          <div className="flex gap-3 overflow-hidden">
            {earnedBadges.length ? (
              earnedBadges.slice(0, 6).map((b) => (
                <span
                  key={b.id}
                  className={`shrink-0 rounded-full ${theme?.bgSoft ?? "bg-cream-sunken"} px-5 py-2.5 text-2xl font-extrabold ${theme?.text ?? ""}`}
                >
                  {b.emoji} {b.label}
                </span>
              ))
            ) : (
              <span className="text-2xl font-bold text-ink-faint">First badge is close — keep going!</span>
            )}
          </div>
        </div>
        {nextBadge && (
          <div className="shrink-0 w-[290px] max-sm:w-full">
            <div className="eyebrow mb-2">Next Up: {nextBadge.label}</div>
            <div className="h-4 rounded-full bg-cream-sunken overflow-hidden">
              <div
                className="h-full rounded-full bg-ember transition-all duration-700"
                style={{ width: `${Math.round(nextBadge.progress * 100)}%` }}
              />
            </div>
            <div className="mt-1.5 text-xl font-bold text-ink-faint">{nextBadge.detail}</div>
          </div>
        )}
      </div>

      {/* Activity cards */}
      <div className="flex-1 min-h-0 flex flex-col gap-4 overflow-y-auto">
        {(summary?.activities ?? []).map((a) => {
          const values = a.history.map((h) => h.value);
          const bestIndex = a.best !== null ? values.lastIndexOf(a.best) : undefined;
          const latestIsBest = a.latest !== null && a.latest === a.best && a.sessions > 1;
          return (
            <div key={a.activity} className="card flex-1 min-h-[170px] flex items-center gap-7 px-8 shrink-0 max-sm:flex-wrap max-sm:gap-4 max-sm:px-4 max-sm:py-4">
              <div className="w-[240px] shrink-0 max-sm:w-auto max-sm:flex-1">
                <div className="text-3xl font-extrabold flex items-center gap-2">
                  <span>
                    {a.emoji} {a.label}
                  </span>
                  <button
                    onClick={() => setRemoveFor(a)}
                    aria-label={`Remove ${a.label}`}
                    className="touch-target w-10 h-10 rounded-tile text-xl text-ink-faint active:bg-cream-sunken"
                  >
                    ✕
                  </button>
                </div>
                <div className="text-xl font-bold text-ink-faint mt-1">
                  {a.sessions} session{a.sessions === 1 ? "" : "s"}
                  {a.totalMinutes > 0 ? ` · ${Math.round(a.totalMinutes)} min total` : ""}
                </div>
              </div>
              <div className="w-[260px] shrink-0 max-sm:w-auto">
                <div className={`text-5xl font-extrabold tabular-nums ${theme?.text ?? ""}`}>
                  {a.best ?? "—"}
                  <span className="text-2xl text-ink-soft font-bold"> {a.unit}</span>
                </div>
                <div className="text-xl font-bold text-ink-soft">
                  {latestIsBest ? "🏆 personal best!" : a.metric === "count" ? "record" : "longest session"}
                </div>
                {a.nextMilestone && (
                  <div className="mt-2">
                    <div className="h-3 w-[210px] rounded-full bg-cream-sunken overflow-hidden">
                      <div
                        className={`h-full rounded-full ${theme?.bg ?? "bg-ember"} transition-all duration-700`}
                        style={{ width: `${Math.round(a.nextMilestone.progress * 100)}%` }}
                      />
                    </div>
                    <div className="text-lg font-bold text-ink-faint mt-1">next: {a.nextMilestone.target}</div>
                  </div>
                )}
              </div>
              <div className="flex-1 flex justify-center min-w-0 max-sm:order-last max-sm:basis-full">
                <Sparkline points={values} color={theme?.fill ?? "#5E7B86"} bestIndex={bestIndex} width={330} height={130} />
              </div>
              <button
                onClick={() => {
                  setEntry(a);
                  setValue("");
                }}
                className={`touch-target shrink-0 rounded-card ${theme?.bg ?? "bg-ink"} text-white px-8 py-5 text-3xl font-extrabold active:scale-95 transition-transform`}
              >
                + Log
              </button>
            </div>
          );
        })}
      </div>

      {/* Add activity — kid-friendly, no PIN */}
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="🏅 New Activity" wide>
        <div className="flex flex-col gap-4">
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {ACTIVITY_EMOJI.map((e) => (
              <button
                key={e}
                onClick={() => setNewEmoji(e)}
                className={`touch-target shrink-0 w-[64px] h-[56px] rounded-tile text-3xl ${
                  newEmoji === e ? "bg-ink text-cream" : "bg-cream-raised shadow-tile active:bg-cream-sunken"
                }`}
              >
                {e}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-4">
            <span className="text-4xl w-14 text-center">{newEmoji}</span>
            <div className="flex-1 rounded-card bg-cream-sunken p-4 text-3xl font-bold min-h-[68px]">
              {newName || <span className="text-ink-faint">What are you training?</span>}
            </div>
            <div className="flex rounded-card overflow-hidden shadow-tile shrink-0">
              {(
                [
                  ["duration", "⏱ Minutes"],
                  ["count", "🔢 Count"],
                ] as const
              ).map(([m, label]) => (
                <button
                  key={m}
                  onClick={() => setNewMetric(m)}
                  className={`touch-target px-6 py-4 text-2xl font-bold ${
                    newMetric === m ? "bg-ink text-cream" : "bg-cream-raised text-ink-soft"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <SoftKeyboard
            value={newName}
            onChange={setNewName}
            doneLabel="Add"
            onDone={async () => {
              if (!kid || !newName.trim()) return;
              const res = await fetch("/api/levelup", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "add_activity", kid, label: newName, emoji: newEmoji, metric: newMetric }),
              });
              if (res.ok) {
                setAddOpen(false);
                load(kid);
                setCelebrate(`${newEmoji} ${newName.trim()} added — go set your first record!`);
                setTimeout(() => setCelebrate(null), 3200);
              }
            }}
          />
        </div>
      </Modal>

      {/* Remove activity — parents only */}
      <PinModal
        open={removeFor !== null}
        onClose={() => setRemoveFor(null)}
        onUnlock={async (pin) => {
          if (!kid || !removeFor) return;
          const slug = removeFor.activity;
          setRemoveFor(null);
          await fetch("/api/levelup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "remove_activity", kid, slug, pin }),
          });
          load(kid);
        }}
        title="Remove Activity"
      />

      {/* Log modal */}
      <Modal
        open={entry !== null}
        onClose={() => setEntry(null)}
        title={entry ? `${entry.emoji} ${entry.label}` : ""}
      >
        {entry && (
          <div className="flex flex-col items-center gap-5">
            <div className="text-3xl font-bold text-ink-soft">
              {entry.metric === "count" ? `How many ${entry.unit}?` : "How many minutes?"}
              {entry.best !== null && <span className="text-ink-faint"> (best: {entry.best})</span>}
            </div>
            <Keypad value={value} onChange={setValue} maxLength={5} />
            <button
              onClick={submit}
              disabled={!value || parseFloat(value) <= 0}
              className="btn-primary px-12 py-5 text-3xl disabled:opacity-40"
            >
              Save Session
            </button>
          </div>
        )}
      </Modal>
    </div>
  );
}
