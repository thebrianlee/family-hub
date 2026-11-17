// Real weather via Open-Meteo — free, keyless, runs on the Pi.
// Location from settings (weather_lat/weather_lon, default a sample city).
// Cached 30 minutes in the settings table so the wall never blocks on it.

import { getSetting, setSetting } from "./queries";

const CACHE_MINUTES = 30;

export interface Weather {
  temp: number;
  hi: number;
  lo: number;
  emoji: string;
  label: string;
}

// WMO weather codes → display
function describe(code: number): { emoji: string; label: string } {
  if (code === 0) return { emoji: "☀️", label: "Sunny" };
  if (code <= 2) return { emoji: "🌤️", label: "Partly Cloudy" };
  if (code === 3) return { emoji: "☁️", label: "Cloudy" };
  if (code === 45 || code === 48) return { emoji: "🌫️", label: "Foggy" };
  if (code <= 57) return { emoji: "🌦️", label: "Drizzle" };
  if (code <= 67) return { emoji: "🌧️", label: "Rain" };
  if (code <= 77) return { emoji: "❄️", label: "Snow" };
  if (code <= 82) return { emoji: "🌦️", label: "Showers" };
  if (code <= 86) return { emoji: "🌨️", label: "Snow Showers" };
  return { emoji: "⛈️", label: "Storms" };
}

export async function getWeather(): Promise<Weather | null> {
  const cachedAt = getSetting("weather_fetched_at", "");
  const cached = getSetting("weather_cache", "");
  const fresh = cachedAt && Date.now() - new Date(cachedAt).getTime() < CACHE_MINUTES * 60_000;
  if (fresh && cached) {
    try {
      return JSON.parse(cached) as Weather;
    } catch {
      /* refetch */
    }
  }

  const lat = getSetting("weather_lat", "39.10");
  const lon = getSetting("weather_lon", "-94.58");
  const zone = encodeURIComponent(getSetting("timezone", "America/Chicago"));
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min` +
    `&temperature_unit=fahrenheit&timezone=${zone}&forecast_days=1`;

  try {
    // no-store: Next's data cache would otherwise pin this URL's first
    // response forever (same params every call) — the wall showed Jul 17
    // weather for two weeks.
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const { emoji, label } = describe(Number(data.current?.weather_code ?? 0));
    const weather: Weather = {
      temp: Math.round(Number(data.current?.temperature_2m ?? 0)),
      hi: Math.round(Number(data.daily?.temperature_2m_max?.[0] ?? 0)),
      lo: Math.round(Number(data.daily?.temperature_2m_min?.[0] ?? 0)),
      emoji,
      label,
    };
    setSetting("weather_cache", JSON.stringify(weather));
    setSetting("weather_fetched_at", new Date().toISOString());
    return weather;
  } catch (err) {
    console.error("[weather] fetch failed:", String(err));
    // stale cache beats nothing
    if (cached) {
      try {
        return JSON.parse(cached) as Weather;
      } catch {
        return null;
      }
    }
    return null;
  }
}
