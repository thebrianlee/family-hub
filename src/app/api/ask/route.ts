import { NextRequest, NextResponse } from "next/server";
import { addQuestion, getRecentQuestions, getSetting, reserveAskSlot } from "@/lib/queries";
import { getMember } from "@/lib/household";
import { ModuleOffError, moduleFetch } from "@/lib/module-fetch";

export const dynamic = "force-dynamic";

// Ask the Hub. The wall sends the question to the local bridge, which calls
// Claude when an API key is set and otherwise tries Ollama. Every Q&A is logged.

// Anyone who can reach the screen can ask, and a paid model costs money per
// question, so the hub caps how fast and how much it will ask on its own.
// The caps are household-wide on purpose: they are a cost ceiling for the
// whole hub, not a per-device or per-kid fairness limit. They count every
// question sent to the model (ask_usage), not only the ones whose answer was
// logged, so a timeout or bridge error still uses up a slot.
const PER_MINUTE = positiveInt(process.env.ASK_MAX_PER_MINUTE, 6);
const PER_DAY = positiveInt(process.env.ASK_MAX_PER_DAY, 100);
const MAX_CONCURRENT = 2;
// One deadline for the whole bridge exchange: connecting, the headers and
// reading the body. A bridge that sends headers and then stalls still frees
// its slot when the deadline passes.
const BRIDGE_TIMEOUT_MS = positiveInt(process.env.ASK_TIMEOUT_MS, 50_000);
let inFlight = 0;

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * The only thing about a kid's age that leaves the hub. The bands follow the
 * bridge's answer styles (bridge/ask-bridge.mjs kidSystem).
 */
function ageBand(age: number | null): string | undefined {
  if (age === null || !Number.isFinite(age)) return undefined;
  if (age < 6) return "under 6";
  if (age < 8) return "6-7";
  if (age < 13) return "8-12";
  return "13 or older";
}

export async function GET(req: NextRequest) {
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit")) || 20, 1), 200);
  return NextResponse.json({ questions: getRecentQuestions(limit) });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  // Questions are logged under a kid's id; anyone else asks as "guest".
  const asker = getMember(body.kid);
  const profile = asker?.role === "kid" ? asker : null;
  const kid = profile ? profile.id : "guest";
  const question = String(body.question ?? "").trim().slice(0, 500);
  if (!question) return NextResponse.json({ error: "Ask me something first!" }, { status: 400 });

  const bridgeUrl = `http://127.0.0.1:${process.env.BRIDGE_PORT || "8787"}`;
  const token = process.env.BRIDGE_TOKEN || "";
  const model = getSetting("ask_model", "sonnet");
  // Only an age band goes to the model, never the exact age. A parent can opt
  // in to sharing first names (settings: ask_share_first_name = "1").
  const shareName = getSetting("ask_share_first_name", "0") === "1";

  // Check and reserve with no await in between: the concurrency slot is taken
  // in the same synchronous run as its check, and the minute and day caps are
  // checked and counted in one database transaction (reserveAskSlot).
  if (inFlight >= MAX_CONCURRENT) return busy();
  const reserved = reserveAskSlot(PER_MINUTE, PER_DAY);
  if (reserved === "minute") return busy();
  if (reserved === "day") {
    return NextResponse.json({ error: "That's all the questions for today. Ask a grown-up, or try tomorrow!" }, { status: 429 });
  }
  inFlight++;
  const ctrl = new AbortController();
  const deadline = setTimeout(() => ctrl.abort(), BRIDGE_TIMEOUT_MS);
  try {
    // Checked again as the request starts: Ask can have been switched off
    // while the question was read.
    const res = await moduleFetch("ask", `${bridgeUrl}/ask`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        kid,
        question,
        model,
        member: profile
          ? { name: shareName ? profile.name : undefined, ageBand: ageBand(profile.age), preReader: profile.preReader }
          : { preReader: false },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`bridge HTTP ${res.status}`);
    // Still under the deadline: the abort also stops a body that never ends.
    const data = await res.json();
    const source = data.source || data.provider || "offline";
    addQuestion(kid, question, data.answer, source, data.model || model, data.latency_ms ?? 0);
    return NextResponse.json({ answer: data.answer, source: data.source });
  } catch (err) {
    if (err instanceof ModuleOffError) return NextResponse.json({ error: "module_off" }, { status: 404 });
    return NextResponse.json(
      { error: "My brain helper isn't answering right now. Try again in a little bit!" },
      { status: 503 }
    );
  } finally {
    clearTimeout(deadline);
    inFlight--;
  }
}

function busy(): NextResponse {
  return NextResponse.json({ error: "Lots of questions right now! Try again in a minute." }, { status: 429 });
}
