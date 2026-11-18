import { NextResponse } from "next/server";
import { calendarProvider } from "@/lib/calendar";
import {
  getParentStatuses, getDinnerFor, isoToday, getBalanceMap, getSetting,
  getFamilyRhythm, getKidDay, getMealDays, getMood, getRules,
} from "@/lib/queries";
import { getKids } from "@/lib/household";
import { enabledModules, enabledTabs } from "@/lib/modules";
import { getSparkTile, refreshSparkIfStale } from "@/lib/spark";
import { refreshIcsIfStale } from "@/lib/ics";
import { getWeather } from "@/lib/weather";

export const dynamic = "force-dynamic";

// A module that is switched off leaves its fields out (the page then skips
// that slot), and its background refresh doesn't run. `tabs` is the tab bar.
export async function GET() {
  const on = enabledModules();
  const calendar = on.includes("calendar");
  const routines = on.includes("routines");
  const rewards = on.includes("rewards");
  const meals = on.includes("meals");
  const ask = on.includes("ask");
  if (calendar) refreshIcsIfStale(); // non-blocking; serves current data while refetching
  if (ask) refreshSparkIfStale(); // non-blocking; fills the Daily Spark cache via the bridge
  const today = new Date();
  const [events, weather] = await Promise.all([
    calendar ? calendarProvider.getWeekEvents(today) : undefined,
    getWeather(),
  ]);
  // Per-kid snapshot for the dashboard: progress ring + mood at a glance.
  // Without routines there is no ring, only the mood.
  const kids = getKids().map((k) => {
    if (!routines) return { kid: k.id, mood: getMood(k.id) };
    const day = getKidDay(k.id);
    const items = [...day.buckets.morning, ...day.buckets.afternoon, ...day.buckets.evening, ...day.jobs];
    return {
      kid: k.id,
      done: items.filter((i) => i.done).length,
      total: items.length,
      mood: day.mood,
      ...(rewards ? { earnedToday: day.earnedToday } : {}),
    };
  });
  return NextResponse.json({
    ...(calendar ? { events } : {}),
    weather,
    statuses: getParentStatuses(),
    ...(rewards ? { balances: getBalanceMap() } : {}),
    currency: getSetting("currency_name", "Family Bucks"),
    ...(meals ? { dinner: getDinnerFor(isoToday(today), today.getDay()) } : {}),
    ...(ask ? { spark: getSparkTile(today) } : {}),
    ...(routines ? { rhythm: getFamilyRhythm() } : {}),
    rules: getRules(),
    greeting: getSetting("family_greeting", "family"),
    kids,
    ...(meals ? { meals: getMealDays(isoToday(today), 1)[0] ?? null } : {}),
    tabs: enabledTabs(on),
  });
}
