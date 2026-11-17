import { NextResponse } from "next/server";
import { calendarProvider } from "@/lib/calendar";
import {
  getParentStatuses, getDinnerFor, isoToday, getBalanceMap, getSetting,
  getFamilyRhythm, getKidDay, getMealDays, getRules,
} from "@/lib/queries";
import { getKids } from "@/lib/household";
import { getSparkTile, refreshSparkIfStale } from "@/lib/spark";
import { refreshIcsIfStale } from "@/lib/ics";
import { getWeather } from "@/lib/weather";

export const dynamic = "force-dynamic";

export async function GET() {
  refreshIcsIfStale(); // non-blocking; serves current data while refetching
  refreshSparkIfStale(); // non-blocking; fills the Daily Spark cache via the bridge
  const today = new Date();
  const [events, weather] = await Promise.all([
    calendarProvider.getWeekEvents(today),
    getWeather(),
  ]);
  // Per-kid snapshot for the dashboard: progress ring + mood at a glance.
  const kids = getKids().map((k) => {
    const day = getKidDay(k.id);
    const items = [...day.buckets.morning, ...day.buckets.afternoon, ...day.buckets.evening, ...day.jobs];
    return {
      kid: k.id,
      done: items.filter((i) => i.done).length,
      total: items.length,
      mood: day.mood,
      earnedToday: day.earnedToday,
    };
  });
  return NextResponse.json({
    events,
    weather,
    statuses: getParentStatuses(),
    balances: getBalanceMap(),
    currency: getSetting("currency_name", "Family Bucks"),
    dinner: getDinnerFor(isoToday(today), today.getDay()),
    spark: getSparkTile(today),
    rhythm: getFamilyRhythm(),
    rules: getRules(),
    greeting: getSetting("family_greeting", "family"),
    kids,
    meals: getMealDays(isoToday(today), 1)[0] ?? null,
  });
}
