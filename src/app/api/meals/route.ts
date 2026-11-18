import { NextRequest, NextResponse } from "next/server";
import { getMealWeek, getMealDays, setMealSlot, clearMealSlot, addMealSlotToList } from "@/lib/queries";
import { MEAL_TYPES, MEAL_TYPE_KEYS } from "@/lib/meals";
import { isEnabled } from "@/lib/modules";

export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const from = req.nextUrl.searchParams.get("from");
  const count = Number(req.nextUrl.searchParams.get("count"));
  const days = from && DATE.test(from) && count > 0 && count <= 42 ? getMealDays(from, count) : getMealWeek();
  return NextResponse.json({ week: days, mealTypes: MEAL_TYPES });
}

// { action:"set", date, slot, name, emoji?, ingredients? }
// { action:"clear", date, slot }
// { action:"addToList", date, slot }
export async function POST(req: NextRequest) {
  const b = await req.json();
  const date = typeof b.date === "string" && DATE.test(b.date) ? b.date : "";
  const slot = typeof b.slot === "string" && MEAL_TYPE_KEYS.includes(b.slot) ? b.slot : "";
  if (!date || !slot) return NextResponse.json({ error: "Invalid date/slot" }, { status: 400 });

  if (b.action === "set") {
    if (typeof b.name !== "string" || !b.name.trim()) return NextResponse.json({ error: "Name it first" }, { status: 400 });
    const ingredients = Array.isArray(b.ingredients)
      ? b.ingredients.filter((x: unknown) => typeof x === "string" && x.trim()).map((x: string) => x.trim())
      : [];
    setMealSlot(date, slot, b.name.trim(), typeof b.emoji === "string" ? b.emoji : "🍽️", ingredients);
    return NextResponse.json({ ok: true, week: getMealWeek() });
  }
  if (b.action === "clear") {
    clearMealSlot(date, slot);
    return NextResponse.json({ ok: true, week: getMealWeek() });
  }
  if (b.action === "addToList") {
    // Writes into Lists: refused like any Lists write while it is switched off.
    if (!isEnabled("lists")) return NextResponse.json({ error: "module_off" }, { status: 404 });
    const added = addMealSlotToList(date, slot);
    return NextResponse.json({ ok: true, added });
  }
  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
