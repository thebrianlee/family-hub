"use client";

// BALANCE — one executive-dashboard card per kid: balance, earning summary,
// recent activity, goal progress. Rewards menu ("the legend") shows what
// everything costs; kids pick goals freely, redeeming spends behind the PIN.

import { useCallback, useEffect, useState } from "react";
import { KidId } from "@/lib/family";
import { newOpId } from "@/lib/op-id";
import { useMembers } from "@/components/MembersProvider";
import Modal from "@/components/Modal";
import PinModal from "@/components/PinModal";
import Keypad from "@/components/Keypad";
import SoftKeyboard from "@/components/SoftKeyboard";

const WISH_EMOJI = ["🧸", "🎮", "⚽", "🎨", "📚", "🍦", "🎬", "🚲", "🛹", "🪁", "🎧", "👟", "🃏", "🦖", "🚀", "🎁"];

interface LedgerEntry {
  id: number;
  amount: number;
  source: string;
  label: string;
  created_at: string;
}

interface Reward {
  id: number;
  label: string;
  emoji: string;
  cost: number;
  kid: string | null;
}

interface RewardRequest {
  id: number;
  kid: string;
  label: string;
  emoji: string;
  status: string;
}

interface KidBalance {
  kid: KidId;
  balance: number;
  earnedTotal: number;
  todayEarned: number;
  weekEarned: number;
  goal: { id: number; label: string; emoji: string; cost: number } | null;
  pendingRequests: RewardRequest[];
  ledger: LedgerEntry[];
}

interface BalanceData {
  currency: string;
  kids: KidBalance[];
  rewards: Reward[];
}

const SOURCE_EMOJI: Record<string, string> = {
  myday: "✅",
  levelup: "📈",
  book: "📚",
  streak_bonus: "🔥",
  redeem: "🎁",
};

function fmtWhen(iso: string): string {
  const d = new Date(iso.replace(" ", "T"));
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export default function BalancePage() {
  const { kids, memberOf } = useMembers();
  const [data, setData] = useState<BalanceData | null>(null);
  const [ledgerFor, setLedgerFor] = useState<KidId | null>(null);
  const [menuFor, setMenuFor] = useState<KidId | null>(null);
  // opId: one key per redemption, made when Redeem is tapped, so a second
  // submit of the same approval is charged once.
  const [redeemPending, setRedeemPending] = useState<{ kid: KidId; reward: Reward; opId: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [wishing, setWishing] = useState(false);
  const [wishName, setWishName] = useState("");
  const [wishEmoji, setWishEmoji] = useState("🎁");
  const [pricing, setPricing] = useState<RewardRequest | null>(null); // after PIN
  const [pricePinFor, setPricePinFor] = useState<RewardRequest | null>(null);
  const [price, setPrice] = useState("");
  const [pricePin, setPricePin] = useState("");

  const load = useCallback(() => fetch("/api/balance").then((r) => r.json()).then(setData).catch(() => {}), []);
  useEffect(() => {
    load();
  }, [load]);

  const post = async (payload: Record<string, unknown>) => {
    const res = await fetch("/api/balance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (res.ok) setData({ currency: body.currency, kids: body.kids, rewards: body.rewards });
    return { ok: res.ok, error: body.error as string | undefined };
  };

  const currency = data?.currency ?? "Family Bucks";
  const ledgerKid = ledgerFor ? data?.kids.find((k) => k.kid === ledgerFor) : null;
  const menuKid = menuFor ? data?.kids.find((k) => k.kid === menuFor) : null;

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3200);
  };

  return (
    <div className="h-full flex flex-col gap-6 min-h-0">
      {toast && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 card bg-cream-raised px-12 py-6 text-4xl font-extrabold animate-pop-in">
          {toast}
        </div>
      )}

      <header className="shrink-0">
        <div className="eyebrow mb-2">Balance</div>
        <h1 className="text-6xl font-extrabold tracking-tight">{currency}</h1>
      </header>

      {/* Executive dashboard cards */}
      <div className="flex-1 min-h-0 flex flex-col gap-6">
        {kids.map((k) => {
          const s = data?.kids.find((x) => x.kid === k.id);
          const goalPct = s?.goal ? Math.min(1, Math.max(0, s.balance / s.goal.cost)) : 0;
          return (
            <div
              key={k.id}
              className={`card flex-1 min-h-0 flex flex-col justify-center px-9 py-6 overflow-hidden border-l-8 ${k.theme.border}`}
            >
              {/* top row: name + balance + actions */}
              <div className="flex items-center gap-8 shrink-0">
                <div className="w-[300px] shrink-0">
                  <div className={`text-4xl font-extrabold ${k.theme.textDeep}`}>{k.name}</div>
                  <div className={`text-7xl font-extrabold tabular-nums ${k.theme.text} mt-1`}>
                    {s?.balance ?? 0}
                    <span className="text-3xl text-ink-soft font-bold"> {currency}</span>
                  </div>
                  <div className="text-2xl font-bold text-ink-soft mt-1">
                    +{s?.todayEarned ?? 0} today · +{s?.weekEarned ?? 0} this week
                  </div>
                </div>

                {/* goal progress */}
                <div className="flex-1 min-w-0">
                  {s?.goal ? (
                    <div>
                      <div className="flex items-baseline justify-between mb-2">
                        <span className="text-3xl font-extrabold truncate">
                          {s.goal.emoji} Saving for: {s.goal.label}
                        </span>
                        <span className="text-2xl font-bold text-ink-soft tabular-nums shrink-0 ml-4">
                          {s.balance} / {s.goal.cost}
                        </span>
                      </div>
                      <div className="h-7 rounded-full bg-cream-sunken overflow-hidden">
                        <div
                          className={`h-full rounded-full ${k.theme.bg} transition-all duration-700`}
                          style={{ width: `${Math.round(goalPct * 100)}%` }}
                        />
                      </div>
                      <div className="text-2xl font-bold text-ink-faint mt-2">
                        {goalPct >= 1
                          ? "🎉 Saved up! Ask Mom or Dad to redeem it."
                          : `${s.goal.cost - s.balance} to go — ${Math.round(goalPct * 100)}% there`}
                      </div>
                    </div>
                  ) : (
                    <div className="text-3xl font-bold text-ink-faint">
                      No goal picked yet — open the menu and choose something to save for!
                    </div>
                  )}
                </div>

                <div className="shrink-0 flex flex-col gap-3">
                  <button
                    onClick={() => setMenuFor(k.id)}
                    className={`touch-target rounded-card ${k.theme.bg} text-white px-8 py-4 text-2xl font-extrabold active:scale-95 transition-transform`}
                  >
                    🎁 Menu
                  </button>
                  <button onClick={() => setLedgerFor(k.id)} className="btn-soft px-8 py-4 text-2xl">
                    📜 Ledger
                  </button>
                </div>
              </div>

              {/* pending wishes awaiting a parent price */}
              {(s?.pendingRequests ?? []).length > 0 && (
                <div className="mt-3 flex gap-3 flex-wrap shrink-0">
                  {s!.pendingRequests.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => setPricePinFor(r)}
                      className="touch-target rounded-full bg-ember-soft px-5 py-2.5 text-xl font-bold text-ember-deep active:scale-95 transition-transform"
                    >
                      {r.emoji} {r.label} — waiting for Mom &amp; Dad
                    </button>
                  ))}
                </div>
              )}

              {/* recent activity strip */}
              <div className="mt-4 pt-3 border-t border-cream-line flex gap-8 overflow-hidden shrink-0">
                {(s?.ledger ?? []).slice(0, 3).map((e) => (
                  <span key={e.id} className="text-2xl font-bold text-ink-soft whitespace-nowrap truncate">
                    {SOURCE_EMOJI[e.source] ?? "⭐"} {e.label}
                    <span className={`ml-2 tabular-nums ${e.amount > 0 ? k.theme.text : "text-ember-deep"}`}>
                      {e.amount > 0 ? "+" : ""}
                      {e.amount}
                    </span>
                  </span>
                ))}
                {s && s.ledger.length === 0 && (
                  <span className="text-2xl font-bold text-ink-faint">Nothing earned yet — go check My Day!</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Rewards menu ("the legend") */}
      <Modal
        open={menuFor !== null}
        onClose={() => setMenuFor(null)}
        title={menuFor ? `🎁 The Menu — ${memberOf(menuFor).name}` : ""}
        wide
      >
        {menuKid && wishing ? (
          <div className="flex flex-col gap-4">
            <div className="eyebrow">What are you wishing for?</div>
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {WISH_EMOJI.map((e) => (
                <button
                  key={e}
                  onClick={() => setWishEmoji(e)}
                  className={`touch-target shrink-0 w-[64px] h-[56px] rounded-tile text-3xl ${
                    wishEmoji === e ? "bg-ink text-cream" : "bg-cream-raised shadow-tile active:bg-cream-sunken"
                  }`}
                >
                  {e}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-4">
              <span className="text-4xl w-14 text-center">{wishEmoji}</span>
              <div className="flex-1 rounded-card bg-cream-sunken p-4 text-3xl font-bold min-h-[68px]">
                {wishName || <span className="text-ink-faint">Name it…</span>}
              </div>
            </div>
            <SoftKeyboard
              value={wishName}
              onChange={setWishName}
              doneLabel="Ask!"
              onDone={async () => {
                if (!wishName.trim() || !menuKid) return;
                await post({ action: "request_reward", kid: menuKid.kid, label: wishName, emoji: wishEmoji });
                setWishing(false);
                setWishName("");
                showToast(`${wishEmoji} Asked! Mom & Dad will set a price.`);
              }}
            />
            <button onClick={() => setWishing(false)} className="btn-soft px-8 py-3 text-xl self-center">
              Back to menu
            </button>
          </div>
        ) : menuKid ? (
          <div className="flex flex-col gap-3 min-h-0 overflow-y-auto pr-1 max-h-[62vh]">
            <div className="flex items-center justify-between mb-1">
              <div className="text-2xl font-bold text-ink-soft">
                {memberOf(menuKid.kid).name} has{" "}
                <span className={memberOf(menuKid.kid).theme.text}>{menuKid.balance} {currency}</span> to spend.
              </div>
              <button
                onClick={() => {
                  setWishing(true);
                  setWishName("");
                  setWishEmoji("🎁");
                }}
                className="btn-primary px-6 py-3 text-xl"
              >
                ✨ Ask for something new
              </button>
            </div>
            {(data?.rewards ?? []).filter((r) => !r.kid || r.kid === menuKid.kid).map((r) => {
              const affordable = menuKid.balance >= r.cost;
              const isGoal = menuKid.goal?.label === r.label;
              return (
                <div key={r.id} className="tile px-6 py-4 flex items-center gap-5">
                  <span className="text-4xl shrink-0">{r.emoji}</span>
                  <span className="flex-1 text-3xl font-bold truncate">{r.label}</span>
                  <span className="text-3xl font-extrabold tabular-nums text-ink-soft shrink-0">{r.cost}</span>
                  <button
                    onClick={async () => {
                      await post({ action: "select_goal", kid: menuKid.kid, rewardId: r.id });
                      showToast(`${r.emoji} Goal set: ${r.label}!`);
                    }}
                    disabled={isGoal}
                    className={`touch-target rounded-card px-6 py-3 text-2xl font-bold transition-colors ${
                      isGoal
                        ? `${memberOf(menuKid.kid).theme.bgSoft} ${memberOf(menuKid.kid).theme.text}`
                        : "bg-cream-sunken text-ink-soft active:bg-cream-line"
                    }`}
                  >
                    {isGoal ? "⭐ My goal" : "Make my goal"}
                  </button>
                  <button
                    onClick={() => setRedeemPending({ kid: menuKid.kid, reward: r, opId: newOpId() })}
                    disabled={!affordable}
                    className="btn-primary px-6 py-3 text-2xl disabled:opacity-35"
                  >
                    Redeem
                  </button>
                </div>
              );
            })}
            <div className="text-xl font-bold text-ink-faint text-center mt-2">
              Redeeming needs a parent. Picking a goal (and wishing) is all yours.
            </div>
          </div>
        ) : null}
      </Modal>

      {/* Price a wish: PIN → keypad */}
      <PinModal
        open={pricePinFor !== null}
        onClose={() => setPricePinFor(null)}
        onUnlock={(p) => {
          setPricing(pricePinFor);
          setPricePinFor(null);
          setPrice("");
          setPricePin(p);
        }}
        title="Set a Price"
      />
      <Modal
        open={pricing !== null}
        onClose={() => setPricing(null)}
        title={pricing ? `${pricing.emoji} ${pricing.label}` : ""}
      >
        {pricing && (
          <div className="flex flex-col items-center gap-5">
            <div className="text-2xl font-bold text-ink-soft">
              How many {currency} should this cost {memberOf(pricing.kid as KidId).name}?
            </div>
            <Keypad value={price} onChange={setPrice} maxLength={5} />
            <div className="flex gap-4">
              <button
                onClick={async () => {
                  if (!price || !pricing) return;
                  const res = await post({ action: "price_request", requestId: pricing.id, cost: Number(price), pin: pricePin });
                  setPricing(null);
                  showToast(res.ok ? `${pricing.emoji} Priced at ${price} — goal set!` : res.error ?? "Failed");
                }}
                disabled={!price || Number(price) < 1}
                className="btn-primary px-10 py-5 text-3xl disabled:opacity-40"
              >
                Set Price
              </button>
              <button
                onClick={async () => {
                  if (!pricing) return;
                  await post({ action: "decline_request", requestId: pricing.id, pin: pricePin });
                  setPricing(null);
                  showToast("Maybe next time.");
                }}
                className="btn-soft px-8 py-5 text-3xl"
              >
                Not this time
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Redeem PIN gate */}
      <PinModal
        open={redeemPending !== null}
        onClose={() => setRedeemPending(null)}
        onUnlock={async (pin) => {
          if (!redeemPending) return;
          const { kid, reward, opId } = redeemPending;
          setRedeemPending(null);
          const res = await post({ action: "redeem", kid, rewardId: reward.id, pin, opId });
          showToast(
            res.ok ? `${reward.emoji} ${memberOf(kid).name} redeemed ${reward.label}!` : res.error ?? "Could not redeem"
          );
        }}
        title="Parent Approval"
      />

      {/* Full ledger */}
      <Modal
        open={ledgerFor !== null}
        onClose={() => setLedgerFor(null)}
        title={ledgerFor ? `${memberOf(ledgerFor).name}'s Ledger` : ""}
        wide
      >
        <div className="flex flex-col gap-3 min-h-0 overflow-y-auto pr-1 max-h-[62vh]">
          {(ledgerKid?.ledger ?? []).map((e) => (
            <div key={e.id} className="tile px-6 py-4 flex items-center gap-5">
              <span className="text-4xl shrink-0">{SOURCE_EMOJI[e.source] ?? "⭐"}</span>
              <span className="flex-1 text-3xl font-bold truncate">{e.label}</span>
              <span className="text-2xl font-bold text-ink-faint shrink-0">{fmtWhen(e.created_at)}</span>
              <span
                className={`w-[110px] text-right text-3xl font-extrabold tabular-nums shrink-0 ${
                  e.amount > 0 ? (ledgerFor ? memberOf(ledgerFor).theme.text : "") : "text-ember-deep"
                }`}
              >
                {e.amount > 0 ? "+" : ""}
                {e.amount}
              </span>
            </div>
          ))}
          {ledgerKid && ledgerKid.ledger.length === 0 && (
            <div className="text-center text-3xl font-bold text-ink-faint py-10">
              Nothing yet — go earn some {currency}!
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
