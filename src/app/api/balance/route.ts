import { isParent } from "@/lib/guard";
import { NextRequest, NextResponse } from "next/server";
import {
  getBalances,
  selectGoal,
  clearGoal,
  redeemReward,
  requestReward,
  priceRequest,
  declineRequest,
} from "@/lib/queries";
import { isKidId } from "@/lib/household";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getBalances());
}

// action = "select_goal" { kid, rewardId }   — kid picks a goal, no PIN
// action = "clear_goal"  { kid }             — no PIN
// action = "redeem"      { kid, rewardId, pin, opId? } — spends the balance, PIN-gated;
//                         opId (one per redemption) makes a resend charge only once
export async function POST(req: NextRequest) {
  const body = await req.json();
  // price_request / decline_request act on a request id, not a kid.
  const kidRequired = !["price_request", "decline_request"].includes(body.action);
  if (kidRequired && (typeof body.kid !== "string" || !isKidId(body.kid))) {
    return NextResponse.json({ error: "Invalid kid" }, { status: 400 });
  }
  switch (body.action) {
    case "select_goal": {
      const res = selectGoal(body.kid, Number(body.rewardId));
      if (!res.ok) return NextResponse.json({ error: "Unknown reward" }, { status: 400 });
      break;
    }
    case "clear_goal":
      clearGoal(body.kid);
      break;
    case "redeem": {
      if (!isParent(req, body)) {
        return NextResponse.json({ error: "Wrong PIN" }, { status: 403 });
      }
      const opId = body.opId ?? null;
      if (opId !== null && (typeof opId !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(opId))) {
        return NextResponse.json({ error: "Invalid request" }, { status: 400 });
      }
      const res = redeemReward(body.kid, Number(body.rewardId), opId);
      if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
      break;
    }
    case "request_reward": {
      if (typeof body.label !== "string" || !body.label.trim()) {
        return NextResponse.json({ error: "Name it first!" }, { status: 400 });
      }
      requestReward(body.kid, body.label.trim(), typeof body.emoji === "string" ? body.emoji : "🎁");
      break;
    }
    case "price_request": {
      if (!isParent(req, body)) {
        return NextResponse.json({ error: "Wrong PIN" }, { status: 403 });
      }
      const cost = Number(body.cost);
      if (!Number.isInteger(cost) || cost < 1 || cost > 100000) {
        return NextResponse.json({ error: "Invalid price" }, { status: 400 });
      }
      const res = priceRequest(Number(body.requestId), cost);
      if (!res.ok) return NextResponse.json({ error: "Request not found" }, { status: 400 });
      break;
    }
    case "decline_request": {
      if (!isParent(req, body)) {
        return NextResponse.json({ error: "Wrong PIN" }, { status: 403 });
      }
      declineRequest(Number(body.requestId));
      break;
    }
    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, ...getBalances() });
}
