"use client";

// KID REWARDS — the payoff layer, mounted inside Routines. Tapping a kid's header
// opens their full drill-down (streaks, Knowledge/Physical metrics, bookshelf,
// mood history) with a Rewards menu to set a goal or redeem (PIN-gated). Lifted
// out of the old standalone Rewards tab when it was folded into Routines.
// The drill-down is the Progress module, the menu is Points & jar, books are
// the Reading log; each part is left out while its module is switched off.
// Without Progress, tapping a kid opens the Rewards menu directly.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { KidId } from "@/lib/family";
import { newOpId } from "@/lib/op-id";
import { useMembers } from "./MembersProvider";
import { useModules } from "./ModulesProvider";
import Modal from "./Modal";
import PinModal from "./PinModal";

export interface Metric { label: string; unit: string; emoji: string; category: "knowledge" | "physical"; total: number; weekTotal: number; sessions: number; }
export interface ShelfBook { id: number; title: string; cover_path: string | null; }
export interface Goal { id: number; label: string; emoji: string; cost: number; }
export interface Progress {
  kid: KidId;
  knowledge: Metric[];
  physical: Metric[];
  routineStreak: number;
  readingStreak: number;
  booksThisYear: number;
  booksAllTime: number;
  shelf: ShelfBook[];
  moodHistory: { date: string; mood: string | null }[];
  mood: string | null;
  currency: string;
  balance: number;
  todayEarned: number;
  weekEarned: number;
  goal: Goal | null;
}
export interface Reward { id: number; label: string; emoji: string; cost: number; kid: string | null; }
/** A kid's points and goal, from /api/balance. */
export interface Wallet { kid: string; balance: number; goal: Goal | null; }

const MOODS = [
  { id: "great", emoji: "😄" }, { id: "good", emoji: "🙂" }, { id: "ok", emoji: "😐" }, { id: "sad", emoji: "😢" }, { id: "mad", emoji: "😠" },
];
const moodEmoji = (id: string | null) => MOODS.find((m) => m.id === id)?.emoji ?? null;
const COVER_COLORS = ["#6E9BBD", "#7FA576", "#D9A254", "#DE7C5A", "#5E7B86", "#3E6D8F"];
export function fmtAmount(total: number, unit: string) {
  if (unit === "min") return total >= 60 ? `${(total / 60).toFixed(total % 60 === 0 ? 0 : 1)} hrs` : `${Math.round(total)} min`;
  return `${Math.round(total)} ${unit}`;
}
function dow(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "narrow" });
}

export default function KidRewards({ drillKid, onClose, all, rewards, wallets, reload }: {
  drillKid: KidId | null;
  onClose: () => void;
  all: Progress[] | null;
  rewards: Reward[];
  wallets: Wallet[];
  reload: () => void;
}) {
  const router = useRouter();
  const { memberOf } = useMembers();
  const { isOn } = useModules();
  const progressOn = isOn("progress");
  const rewardsOn = isOn("rewards");
  const readingOn = isOn("reading");
  const [menuKid, setMenuKid] = useState<KidId | null>(null);
  // opId: one key per redemption (see app/balance/page.tsx).
  const [redeemFor, setRedeemFor] = useState<{ kid: KidId; reward: Reward; opId: string } | null>(null);

  const byKid = (k: KidId) => all?.find((p) => p.kid === k) ?? null;
  const walletOf = (k: KidId) => wallets.find((w) => w.kid === k) ?? null;
  // Opened from the drill-down, or straight from the kid's header without Progress.
  const menuFor = !rewardsOn ? null : menuKid ?? (progressOn ? null : drillKid);
  const closeMenu = () => {
    if (menuKid === null) onClose();
    setMenuKid(null);
  };
  const pickGoal = async (kid: KidId, rewardId: number) => {
    await fetch("/api/balance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "select_goal", kid, rewardId }) });
    reload(); closeMenu();
  };
  const redeem = async (pin: string) => {
    if (!redeemFor) return;
    const { kid, reward, opId } = redeemFor;
    setRedeemFor(null);
    await fetch("/api/balance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "redeem", kid, rewardId: reward.id, pin, opId }) });
    reload(); closeMenu();
  };

  const drill = drillKid && progressOn ? byKid(drillKid) : null;

  return (
    <>
      {/* Drill-down: full progress for one kid */}
      <Modal open={progressOn && drillKid !== null} onClose={onClose} title={drillKid ? `${memberOf(drillKid).name}'s Progress` : ""} wide>
        {drill && drillKid && (
          <DrillDown
            p={drill}
            theme={memberOf(drillKid).theme}
            reading={readingOn}
            onBooks={() => { onClose(); router.push("/reading"); }}
            onMenu={rewardsOn ? () => setMenuKid(drillKid) : null}
          />
        )}
      </Modal>

      {/* Rewards menu — set a goal or redeem */}
      <Modal open={menuFor !== null} onClose={closeMenu} title={menuFor ? `${memberOf(menuFor).name}'s Rewards · ⭐${walletOf(menuFor)?.balance ?? 0}` : ""} wide>
        {menuFor && (
          <div className="flex flex-col gap-3 min-h-0 overflow-y-auto pr-1">
            {rewards.filter((r) => r.kid === null || r.kid === menuFor).sort((a, b) => a.cost - b.cost).map((r) => {
              const bal = walletOf(menuFor)?.balance ?? 0;
              const affordable = bal >= r.cost;
              const isGoal = walletOf(menuFor)?.goal?.label === r.label;
              return (
                <div key={r.id} className="tile px-6 py-4 flex items-center gap-5">
                  <span className="text-4xl shrink-0">{r.emoji}</span>
                  <span className="flex-1 text-3xl font-extrabold">{r.label}</span>
                  <span className={`text-2xl font-extrabold tabular-nums shrink-0 ${affordable ? "text-sage-deep" : "text-ink-faint"}`}>{r.cost}</span>
                  {isGoal ? <span className="shrink-0 text-xl font-bold text-ember-deep px-3">🎯 goal</span> : <button onClick={() => pickGoal(menuFor, r.id)} className="btn-soft shrink-0 px-5 py-3 text-xl">Set goal</button>}
                  <button onClick={() => affordable && setRedeemFor({ kid: menuFor, reward: r, opId: newOpId() })} disabled={!affordable} className={`shrink-0 rounded-tile px-6 py-3 text-xl font-extrabold ${affordable ? "bg-ink text-cream" : "bg-cream-sunken text-ink-faint"}`}>Redeem</button>
                </div>
              );
            })}
          </div>
        )}
      </Modal>
      <PinModal open={redeemFor !== null} onClose={() => setRedeemFor(null)} onUnlock={redeem} title={redeemFor ? `Redeem ${redeemFor.reward.emoji} ${redeemFor.reward.label}?` : ""} />
    </>
  );
}

// reading: the Reading log is on (books, reading streak, shelf). onMenu: null
// while Points & jar is off.
function DrillDown({ p, theme, reading, onBooks, onMenu }: { p: Progress; theme: { text: string; bg: string }; reading: boolean; onBooks: () => void; onMenu: (() => void) | null }) {
  return (
    <div className="flex flex-col gap-4 min-h-0 overflow-y-auto pr-1">
      <div className="flex items-center gap-4 flex-wrap">
        <div className="well px-5 py-3"><span className={`text-3xl font-extrabold ${theme.text}`}>🔥{p.routineStreak}</span><div className="text-sm font-bold text-ink-soft">routine</div></div>
        {reading && <div className="well px-5 py-3"><span className={`text-3xl font-extrabold ${theme.text}`}>📖{p.readingStreak}</span><div className="text-sm font-bold text-ink-soft">reading</div></div>}
        {reading && <div className="well px-5 py-3"><span className={`text-3xl font-extrabold ${theme.text}`}>🏆{p.booksThisYear}</span><div className="text-sm font-bold text-ink-soft">books/yr</div></div>}
        <div className="flex-1" />
        {reading && <button onClick={onBooks} className="btn-soft px-5 py-3 text-xl">📚 Books</button>}
        {onMenu && <button onClick={onMenu} className={`shrink-0 rounded-tile px-6 py-3 text-xl font-extrabold ${theme.bg} text-white active:opacity-90`}>🎁 Rewards</button>}
      </div>
      <div className="card px-5 py-3 flex items-center gap-4">
        <span className="eyebrow shrink-0">Mood</span>
        <div className="flex-1 flex justify-between">
          {p.moodHistory.map((d) => (<div key={d.date} className="flex flex-col items-center"><span className="text-3xl">{d.mood ? moodEmoji(d.mood) : "·"}</span><span className="text-sm font-bold text-ink-faint">{dow(d.date)}</span></div>))}
        </div>
      </div>
      {(["knowledge", "physical"] as const).map((cat) => {
        const metrics = cat === "knowledge" ? p.knowledge : p.physical;
        if (!metrics.length) return null;
        return (
          <div key={cat}>
            <div className="eyebrow mb-2">{cat === "knowledge" ? "🧠 Knowledge" : "💪 Physical"}</div>
            <div className="grid grid-cols-3 gap-3">
              {metrics.map((m) => (
                <div key={m.label} className="tile px-4 py-3">
                  <div className="text-xl font-extrabold flex items-center gap-1.5"><span>{m.emoji}</span><span className="truncate">{m.label}</span></div>
                  <div className={`text-3xl font-extrabold ${theme.text}`}>{fmtAmount(m.total, m.unit)}</div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
      {reading && p.shelf.length > 0 && (
        <div>
          <div className="eyebrow mb-2">🏆 Bookshelf — {p.booksAllTime}</div>
          <div className="flex gap-3 overflow-x-auto pb-1">
            {p.shelf.map((b) => b.cover_path ? (
               
              <img key={b.id} src={b.cover_path} alt={b.title} className="w-[92px] aspect-[3/4] shrink-0 rounded-tile shadow-card object-cover" />
            ) : (
              <div key={b.id} className="w-[92px] aspect-[3/4] shrink-0 rounded-tile shadow-card flex items-center justify-center p-2 text-center text-white text-sm font-extrabold" style={{ background: COVER_COLORS[b.id % COVER_COLORS.length] }}>{b.title}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
