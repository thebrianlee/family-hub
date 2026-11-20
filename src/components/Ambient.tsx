"use client";

// Ambient wrapper: screensaver after N idle minutes, sleep-dark overlay
// inside the configured window. Any touch exits the screensaver back to
// Today; a touch during sleep wakes the screen for 5 minutes.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useModules } from "./ModulesProvider";
import { goToUnlock } from "@/lib/unlock-redirect";

interface Quote {
  kind: string;
  text: string;
  attribution?: string;
}

export interface AmbientConfig {
  photos: string[];
  art: string[];
  quotes: Quote[];
  idleMinutes: number;
  sleepStart: string; // "HH:MM"
  sleepEnd: string;
  hardwareSleep?: boolean;
  weather?: { temp: number; emoji: string; label: string } | null;
}

type Slide = { type: "image"; src: string } | { type: "quote"; quote: Quote };

const SLIDE_SECONDS = 5;
const FADE_SECONDS = 1.2;

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function inSleepWindow(now: Date, start: string, end: string): boolean {
  const n = now.getHours() * 60 + now.getMinutes();
  const s = minutesOf(start);
  const e = minutesOf(end);
  return s <= e ? n >= s && n < e : n >= s || n < e; // window may cross midnight
}

/** The quotes to show. The family rules are core; the other quotes come with
 *  Ask (/api/ambient), so while Ask is off only the rules are shown, even from
 *  a config read before it was switched off. */
export function deckQuotes(quotes: Quote[], askOn: boolean): Quote[] {
  return askOn ? quotes : quotes.filter((q) => q.kind === "rule");
}

/** Deterministic slide deck: strictly alternate photo ↔ quote. Photos repeat
 *  cyclically, so even a single family photo stays on screen half the time. */
function buildDeck(cfg: AmbientConfig, askOn: boolean): Slide[] {
  const images = [...cfg.photos, ...cfg.art].map((src) => ({ type: "image" as const, src }));
  const quotes = deckQuotes(cfg.quotes, askOn).map((quote) => ({ type: "quote" as const, quote }));
  if (!images.length) return quotes;
  if (!quotes.length) return images;
  const pairs = Math.max(images.length, Math.min(quotes.length, 6));
  const deck: Slide[] = [];
  for (let i = 0; i < pairs; i++) {
    deck.push(images[i % images.length]);
    deck.push(quotes[i % quotes.length]);
  }
  return deck;
}

function QuoteCard({ quote }: { quote: Quote }) {
  const isRule = quote.kind === "rule";
  return (
    <div className="h-full w-full flex items-center justify-center bg-cream">
      <div className="max-w-[1050px] px-24 text-center">
        <div className="eyebrow mb-10">{isRule ? "Family Rules" : "Words to Live By"}</div>
        <div className="text-7xl font-extrabold leading-tight text-ink tracking-tight">
          &ldquo;{quote.text}&rdquo;
        </div>
        {quote.attribution && (
          <div className="mt-12 text-4xl font-bold text-ink-soft">— {quote.attribution}</div>
        )}
        <div className="mt-16 mx-auto w-24 h-1.5 rounded-full bg-ember" />
      </div>
    </div>
  );
}

/** The screensaver settings from an /api/ambient answer, or null when there are
 *  none to use. A screen that is not unlocked yet gets 401 (the unlock page
 *  itself renders inside this wrapper), and an error body has none of these
 *  fields: treating it as settings crashed the unlock page, so nobody could
 *  enter the PIN. Without settings the screensaver simply stays off. */
export function ambientConfigFrom(ok: boolean, body: unknown): AmbientConfig | null {
  if (!ok || !body || typeof body !== "object") return null;
  const c = body as Partial<AmbientConfig>;
  if (!Array.isArray(c.photos) || !Array.isArray(c.art) || !Array.isArray(c.quotes)) return null;
  if (typeof c.idleMinutes !== "number" || typeof c.sleepStart !== "string" || typeof c.sleepEnd !== "string") return null;
  return c as AmbientConfig;
}

/** One /api/ambient read. `locked` is true when the answer says this screen
 *  is not unlocked (401), so settings loaded earlier must be dropped too. */
function loadAmbient(): Promise<AmbientLoad> {
  // A stalled request counts as a network error after 5 s, so it can't hold
  // the screensaver back for good. A timer, not AbortSignal.timeout, which
  // older browsers lack.
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<AmbientLoad>((resolve) => {
    timer = setTimeout(() => {
      controller?.abort();
      resolve({ cfg: null, locked: false });
    }, 5_000);
  });
  const request = fetch("/api/ambient", { signal: controller?.signal })
    .then(async (r) => ({ cfg: ambientConfigFrom(r.ok, await r.json().catch(() => null)), locked: r.status === 401 }))
    .catch(() => ({ cfg: null, locked: false }));
  return Promise.race([request, timedOut]).finally(() => clearTimeout(timer));
}

type AmbientLoad = { cfg: AmbientConfig | null; locked: boolean };

/** Use fresh settings. On a 401 drop the old ones, leave the screensaver and
 *  go to /unlock, so a screen that lost its unlock (cookie expired, PIN
 *  changed) shows no household content. A network error keeps what it had. */
export function applyAmbient(
  { cfg, locked }: AmbientLoad,
  setCfg: (c: AmbientConfig | null) => void,
  setSaver: (on: boolean) => void,
  onLocked: () => void = goToUnlock
): void {
  if (cfg) setCfg(cfg);
  else if (locked) {
    setCfg(null);
    setSaver(false);
    onLocked();
  }
}

/** Whether the screensaver may start, idle or by the moon button. The slides
 *  are household content (photos, rules), so the screen asks the hub first and
 *  keeps the saver off while it waits: still unlocked shows them, locked goes
 *  to /unlock, and a network error shows the slides it already had. */
export function saverEntry(load: AmbientLoad): "saver" | "unlock" {
  return load.locked ? "unlock" : "saver";
}

export default function Ambient({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const askOn = useModules().isOn("ask");
  const [cfg, setCfg] = useState<AmbientConfig | null>(null);
  const [saver, setSaver] = useState(false);
  const [slideIdx, setSlideIdx] = useState(0);
  const [sleeping, setSleeping] = useState(false);
  const lastActivity = useRef(0);
  const wakeUntil = useRef(0);
  const lastRefetch = useRef(0);
  const entering = useRef(false);
  const saverRef = useRef(false);
  useEffect(() => {
    saverRef.current = saver;
  }, [saver]);
  const bootedAt = useRef(0);
  const [clock, setClock] = useState("");

  useEffect(() => {
    const now = Date.now();
    lastActivity.current = now;
    lastRefetch.current = now;
    bootedAt.current = now;
    loadAmbient().then((load) => applyAmbient(load, setCfg, setSaver));
  }, []);

  // Manual screensaver (the moon button) + fresh weather on entry.
  useEffect(() => {
    const onSleep = () => {
      loadAmbient().then((load) => {
        if (saverEntry(load) === "unlock") return applyAmbient(load, setCfg, setSaver);
        if (load.cfg) setCfg(load.cfg);
        setSaver(true);
      });
    };
    window.addEventListener("sproutwall:sleep", onSleep);
    return () => window.removeEventListener("sproutwall:sleep", onSleep);
  }, []);

  // Track activity.
  const markActivity = useCallback(() => {
    lastActivity.current = Date.now();
  }, []);
  useEffect(() => {
    const events: (keyof WindowEventMap)[] = ["pointerdown", "pointermove", "keydown", "touchstart"];
    events.forEach((e) => window.addEventListener(e, markActivity, { passive: true }));
    return () => events.forEach((e) => window.removeEventListener(e, markActivity));
  }, [markActivity]);

  // Idle + sleep tick.
  useEffect(() => {
    if (!cfg) return;
    const tick = setInterval(() => {
      const now = new Date();
      setClock(now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }));
      // With hardware sleep the Pi powers the panel off; the app must not paint
      // its own black overlay (a night touch should wake to the live app).
      const asleep =
        !cfg.hardwareSleep &&
        inSleepWindow(now, cfg.sleepStart, cfg.sleepEnd) &&
        Date.now() > wakeUntil.current;
      setSleeping(asleep);
      const idleMs = Date.now() - lastActivity.current;
      if (!asleep && idleMs > cfg.idleMinutes * 60_000 && !saverRef.current && !entering.current) {
        entering.current = true;
        loadAmbient().then((load) => {
          entering.current = false;
          if (saverEntry(load) === "unlock") return applyAmbient(load, setCfg, setSaver);
          if (load.cfg) setCfg(load.cfg);
          // Activity during the check cancels it.
          if (Date.now() - lastActivity.current > cfg.idleMinutes * 60_000) setSaver(true);
        });
      }
      // Kiosk freshness: pages fetch on mount + sproutwall:datachanged, but the
      // wall stays mounted for days. Rebroadcast so whatever tab is showing
      // refetches (moved/added Google events appear within 5 min)...
      if (Date.now() - lastRefetch.current > 5 * 60_000) {
        lastRefetch.current = Date.now();
        window.dispatchEvent(new CustomEvent("sproutwall:datachanged"));
      }
      // ...and a nightly reload resets mount-time state (calendar anchor,
      // "today" highlights) before the family wakes.
      if (now.getHours() === 3 && now.getMinutes() >= 30 && Date.now() - bootedAt.current > 6 * 3_600_000) {
        window.location.reload();
      }
    }, 5_000);
    return () => clearInterval(tick);
  }, [cfg]);

  // Slide rotation.
  useEffect(() => {
    if (!saver) return;
    const t = setInterval(() => setSlideIdx((i) => i + 1), SLIDE_SECONDS * 1000);
    return () => clearInterval(t);
  }, [saver]);

  const deck = cfg ? buildDeck(cfg, askOn) : [];
  const current = deck.length ? deck[slideIdx % deck.length] : null;
  const next = deck.length ? deck[(slideIdx + 1) % deck.length] : null;

  const exitSaver = () => {
    markActivity();
    setSaver(false);
    router.push("/today"); // wake to the family dashboard
  };

  const wake = () => {
    markActivity();
    wakeUntil.current = Date.now() + 5 * 60_000; // wake for 5 minutes
    setSleeping(false);
  };

  return (
    <>
      {children}

      {saver && !sleeping && (
        <div className="fixed inset-0 z-[90] cursor-none" onPointerDown={exitSaver}>
          {/* two stacked layers for the crossfade */}
          {next && next.type === "image" && (
             
            <img src={next.src} alt="" className="absolute inset-0 h-full w-full object-cover" />
          )}
          {next && next.type === "quote" && (
            <div className="absolute inset-0">
              <QuoteCard quote={next.quote} />
            </div>
          )}
          {current && (
            <div
              key={slideIdx}
              className="absolute inset-0"
              style={{ animation: `fade-in ${FADE_SECONDS}s ease-in-out reverse forwards`, animationDelay: `${SLIDE_SECONDS - FADE_SECONDS}s` }}
            >
              {current.type === "image" ? (
                 
                <img
                  src={current.src}
                  alt=""
                  className="h-full w-full object-cover"
                  style={{ animation: `kenburns ${SLIDE_SECONDS + FADE_SECONDS}s ease-out both` }}
                />
              ) : (
                <QuoteCard quote={current.quote} />
              )}
            </div>
          )}
          {/* overlays: weather top-left, time + date top-right (Hearth-style) */}
          {cfg?.weather && (
            <div className="absolute top-8 left-10 text-3xl font-bold text-cream/90 mix-blend-difference">
              {cfg.weather.emoji} {cfg.weather.temp}°
            </div>
          )}
          <div className="absolute top-8 right-10 text-right mix-blend-difference">
            <div className="text-5xl font-extrabold text-cream/90 tabular-nums">{clock}</div>
            <div className="text-2xl font-bold text-cream/80">
              {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
            </div>
          </div>
        </div>
      )}

      {sleeping && (
        <div
          className="fixed inset-0 z-[100] bg-ink-deep flex items-end justify-center pb-24"
          onPointerDown={wake}
        >
          <div className="text-3xl font-bold text-cream/25 tabular-nums">{clock}</div>
        </div>
      )}
    </>
  );
}
