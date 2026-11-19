// Daily Spark content.
//
// The Today tile rotates daily among five kinds: quote, historical fact,
// growth-mindset prompt, dinner-table question, family rule. Rules come from
// the parent-editable family_rules table; the rest are hardcoded 15-item
// lists. A nightly Anthropic API job can INSERT rows into spark_cache and
// getDailySpark()/getSparkTile() will prefer them — zero UI changes needed.

import { getDb } from "./db";
import { ModuleOffError, moduleFetch } from "./module-fetch";

export type SparkKind = "quote" | "fact" | "mindset" | "dinner" | "rule";

export interface SparkItem {
  kind: SparkKind;
  text: string;
  attribution?: string;
}

const QUOTES: SparkItem[] = [
  { kind: "quote", text: "You miss 100% of the shots you don't take.", attribution: "Wayne Gretzky" },
  { kind: "quote", text: "It always seems impossible until it's done.", attribution: "Nelson Mandela" },
  { kind: "quote", text: "Do what you can, with what you have, where you are.", attribution: "Theodore Roosevelt" },
  { kind: "quote", text: "A person who never made a mistake never tried anything new.", attribution: "Albert Einstein" },
  { kind: "quote", text: "The secret of getting ahead is getting started.", attribution: "Mark Twain" },
  { kind: "quote", text: "Whether you think you can or you think you can't, you're right.", attribution: "Henry Ford" },
  { kind: "quote", text: "The best way to predict the future is to invent it.", attribution: "Alan Kay" },
  { kind: "quote", text: "Everything you can imagine is real.", attribution: "Pablo Picasso" },
  { kind: "quote", text: "No one is perfect. That's why pencils have erasers.", attribution: "Wolfgang Riebe" },
  { kind: "quote", text: "Why fit in when you were born to stand out?", attribution: "Dr. Seuss" },
  { kind: "quote", text: "It does not matter how slowly you go as long as you do not stop.", attribution: "Confucius" },
  { kind: "quote", text: "Fall seven times, stand up eight.", attribution: "Japanese proverb" },
  { kind: "quote", text: "The more that you read, the more things you will know.", attribution: "Dr. Seuss" },
  { kind: "quote", text: "Hard work beats talent when talent doesn't work hard.", attribution: "Tim Notke" },
  { kind: "quote", text: "Little by little, one travels far.", attribution: "J.R.R. Tolkien" },
];




export const SPARK_KIND_LABEL: Record<SparkKind, string> = {
  quote: "Quote of the Day",
  fact: "From the History Books",
  mindset: "Think About It",
  dinner: "Dinner Table Question",
  rule: "Family Rules",
};

function dayOfYear(d: Date): number {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d.getTime() - start.getTime()) / 86_400_000);
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function getFamilyRules(): SparkItem[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT text FROM family_rules WHERE active=1 ORDER BY sort")
    .all() as { text: string }[];
  return rows.map((r) => ({ kind: "rule" as const, text: r.text }));
}

/** Screensaver deck: freshest generated quotes first, seed list as filler. */
export function getQuotes(): SparkItem[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT content FROM spark_cache WHERE kind='quote' ORDER BY date DESC LIMIT 14")
    .all() as { content: string }[];
  const fresh: SparkItem[] = [];
  for (const r of rows) {
    try {
      const it = JSON.parse(r.content) as SparkItem;
      if (it?.text) fresh.push({ kind: "quote", text: it.text, attribution: it.attribution });
    } catch {
      /* skip */
    }
  }
  const seen = new Set(fresh.map((q) => q.text));
  return [...fresh, ...QUOTES.filter((q) => !seen.has(q.text))].slice(0, 20);
}

let sparkRefreshInFlight = false;

/**
 * Keep spark_cache filled ~5 days ahead with fresh content from the Ask the
 * Hub bridge (Anthropic or Ollama). Fire-and-forget from /api/today, same pattern as the
 * ICS refresh; on any failure the hardcoded lists keep serving.
 */
export function refreshSparkIfStale(): void {
  const db = getDb();
  const dates: string[] = [];
  const d = new Date();
  for (let i = 0; i < 5; i++) {
    dates.push(isoDate(d));
    d.setDate(d.getDate() + 1);
  }
  const have = new Set(
    (db
      .prepare(`SELECT DISTINCT date FROM spark_cache WHERE kind='quote' AND date IN (${dates.map(() => "?").join(",")})`)
      .all(...dates) as { date: string }[]).map((r) => r.date)
  );
  const missing = dates.filter((x) => !have.has(x));
  if (!missing.length || sparkRefreshInFlight) return;
  sparkRefreshInFlight = true;

  const bridge = `http://127.0.0.1:${process.env.BRIDGE_PORT || "8787"}`;
  const token = process.env.BRIDGE_TOKEN || "";
  if (token.length < 16) {
    sparkRefreshInFlight = false;
    return;
  }

  // Everything the wall has already shown: the seed list + every cached
  // quote. Sent to the generator as a ban list, and enforced again on insert.
  const avoid = new Set<string>(QUOTES.map((q) => q.text.toLowerCase()));
  for (const r of db.prepare("SELECT content FROM spark_cache WHERE kind='quote'").all() as { content: string }[]) {
    try {
      avoid.add((JSON.parse(r.content).text as string).toLowerCase());
    } catch {
      /* skip */
    }
  }

  (async () => {
    // Ask switched off since /api/today checked: the bridge is not called.
    // The local bridge never redirects, so a redirect is refused, not followed.
    const res = await moduleFetch("ask", `${bridge}/generate`, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      cache: "no-store",
      body: JSON.stringify({ days: missing, avoid: Array.from(avoid).slice(0, 120) }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`bridge HTTP ${res.status}`);
    const data = await res.json();
    const ins = db.prepare("INSERT OR REPLACE INTO spark_cache (date, kind, content) VALUES (?, ?, ?)");
    let n = 0;
    for (const day of data.days ?? []) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day?.date))) continue;
      for (const kind of ["quote", "fact", "mindset", "dinner"] as const) {
        const item = day[kind];
        if (!item?.text) continue;
        if (kind === "quote" && avoid.has(String(item.text).toLowerCase())) continue;
        ins.run(
          day.date,
          kind,
          JSON.stringify({
            kind,
            text: String(item.text).slice(0, 200),
            ...(item.attribution ? { attribution: String(item.attribution).slice(0, 80) } : {}),
          })
        );
        n++;
      }
    }
    db.prepare("DELETE FROM spark_cache WHERE date < date('now', '-30 days')").run();
    console.log(`[spark] refreshed ${n} items for ${missing.join(", ")}`);
  })()
    .catch((e) => {
      if (!(e instanceof ModuleOffError)) console.error("[spark] refresh failed:", String(e));
    })
    .finally(() => {
      sparkRefreshInFlight = false;
    });
}

/** The single Today-view tile: a fresh Quote of the Day, every day. The
 * other generated kinds (fact/mindset/dinner) stay in spark_cache for the
 * screensaver and future cards. */
export function getSparkTile(today = new Date()): SparkItem & { label: string } {
  const db = getDb();
  const date = isoDate(today);
  const idx = dayOfYear(today);
  const kind: SparkKind = "quote";

  const cached = db
    .prepare("SELECT content FROM spark_cache WHERE date=? AND kind=?")
    .get(date, kind) as { content: string } | undefined;
  if (cached) {
    try {
      const item = JSON.parse(cached.content) as SparkItem;
      return { ...item, label: SPARK_KIND_LABEL[kind] };
    } catch {
      /* fall through */
    }
  }

  // Cache miss (bridge down / not yet filled): serve from the seed list.
  const item = QUOTES[idx % QUOTES.length];
  return { ...item, label: SPARK_KIND_LABEL[kind] };
}
