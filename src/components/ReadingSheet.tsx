"use client";

// Reading drill-down — opens when a kid taps their "Reading" routine. Shows the
// book(s) they're on, logs tonight's minutes (which ticks the routine), lets
// them finish a book, or start a new one by search. Book-level detail lives on
// the routine, not hidden under Rewards.

import { useCallback, useEffect, useRef, useState } from "react";
import { KidId } from "@/lib/family";
import { useMembers } from "./MembersProvider";
import { useModules } from "./ModulesProvider";
import Modal from "./Modal";
import Keypad from "./Keypad";
import SoftKeyboard from "./SoftKeyboard";

interface ReadingBook {
  id: number;
  title: string;
  author: string | null;
  cover_path: string | null;
  day: number;
}
interface Summary {
  reading: ReadingBook[];
  finishedThisYear: number;
  streak: number;
}
interface SearchResult {
  title: string;
  author: string | null;
  isbn: string | null;
  thumbnail: string | null;
  year: string | null;
}

const MIN_CHIPS = [10, 15, 20, 30];

export default function ReadingSheet({
  open, kid, templateId, unit, done, onClose, onLogged,
}: {
  open: boolean;
  kid: KidId | null;
  templateId: number | null;
  unit: string | null;
  done: boolean;
  onClose: () => void;
  onLogged: (msg: string, close: boolean) => void;
}) {
  const { memberOf } = useMembers();
  // Points are still earned with Points & jar off; the "+N" is just not shown.
  const { isOn } = useModules();
  const plus = (n: number) => (isOn("rewards") ? ` +${n}` : "");
  // Shown, and fetching, only while Reading is on, whatever the parent passes.
  const active = open && isOn("reading");
  const activeRef = useRef(active);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [minutes, setMinutes] = useState("");
  const [mode, setMode] = useState<"main" | "search">("main");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);

  // An answer that lands after the sheet closed or Reading went off is dropped.
  const load = useCallback(() => {
    if (!kid || !activeRef.current) return;
    fetch(`/api/reading?kid=${kid}`)
      .then((r) => r.json())
      .then((d) => { if (activeRef.current) setSummary(d.summary); })
      .catch(() => {});
  }, [kid]);
  // Fresh on every open; the book, minutes and search go as soon as the sheet
  // closes or Reading is switched off.
  useEffect(() => {
    activeRef.current = active;
    setMode("main"); setMinutes(""); setQuery(""); setResults(null);
    if (active) load();
    else setSummary(null);
  }, [active, load]);

  const post = (body: Record<string, unknown>) =>
    fetch("/api/reading", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kid, ...body }) });

  const finish = async (b: ReadingBook) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await post({ action: "finish", bookId: b.id });
      const body = await res.json().catch(() => ({}));
      window.dispatchEvent(new CustomEvent("sproutwall:datachanged"));
      load();
      if (res.ok) onLogged(`📚 "${b.title}" goes on the shelf!${plus(body.earned ?? 15)}`, false);
    } finally { setBusy(false); }
  };

  const startBook = async (r: SearchResult) => {
    if (busy) return;
    setBusy(true);
    try {
      await post({ action: "start", title: r.title, author: r.author, isbn: r.isbn, coverUrl: r.thumbnail });
      window.dispatchEvent(new CustomEvent("sproutwall:datachanged"));
      setMode("main"); setQuery(""); setResults(null);
      load();
    } finally { setBusy(false); }
  };

  const runSearch = async () => {
    if (!activeRef.current || query.trim().length < 2) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/books/search?q=${encodeURIComponent(query.trim())}`);
      const found = (await res.json()).results ?? [];
      if (activeRef.current) setResults(found);
    } catch { if (activeRef.current) setResults([]); } finally { setBusy(false); }
  };

  // Log tonight's minutes → ticks the Reading routine.
  const logMinutes = async (m: number) => {
    if (!kid || !templateId || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/myday", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kid, templateId, amount: m }),
      });
      const body = await res.json().catch(() => ({}));
      window.dispatchEvent(new CustomEvent("sproutwall:datachanged"));
      if (res.ok && !body.alreadyDone) {
        const name = memberOf(kid).name;
        onLogged(body.bucketDone ? `🎉 ${name} finished the evening!${plus(body.earned)}` : `📖 ${m} ${unit} logged${isOn("rewards") ? ` · +${body.earned}` : ""}`, true);
      } else {
        onClose();
      }
    } finally { setBusy(false); }
  };

  const name = kid ? memberOf(kid).name : "";

  return (
    <Modal open={active} onClose={onClose} title={`📖 ${name}'s Reading`} wide>
      {mode === "main" ? (
        <div className="flex flex-col gap-5 min-h-0 overflow-y-auto pr-1">
          {/* current books */}
          <div>
            <div className="eyebrow mb-2">Now reading</div>
            {summary && summary.reading.length === 0 ? (
              <div className="tile px-6 py-5 text-2xl font-bold text-ink-faint">No book on the go — start one below.</div>
            ) : (
              <div className="flex flex-col gap-3">
                {(summary?.reading ?? []).map((b) => (
                  <div key={b.id} className="tile px-5 py-4 flex items-center gap-4">
                    {b.cover_path ? (
                       
                      <img src={b.cover_path} alt="" className="w-[64px] h-[92px] rounded-lg object-cover shrink-0 shadow-tile" />
                    ) : (
                      <div className="w-[64px] h-[92px] rounded-lg bg-cream-sunken flex items-center justify-center text-3xl shrink-0">📖</div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-2xl font-extrabold leading-tight line-clamp-2">{b.title}</div>
                      <div className="text-lg font-bold text-ink-faint">Day {b.day}</div>
                    </div>
                    <button onClick={() => finish(b)} disabled={busy} className="touch-target shrink-0 rounded-tile bg-ink text-cream px-5 py-3 text-xl font-extrabold active:scale-95 transition-transform">✓ Finished!</button>
                  </div>
                ))}
              </div>
            )}
            <button onClick={() => setMode("search")} className="btn-soft mt-3 px-6 py-3 text-xl">＋ Start a new book</button>
          </div>

          {/* log minutes → completes the routine */}
          <div className="border-t border-cream-line pt-4">
            <div className="eyebrow mb-2">{done ? "Read more?" : "How long did you read tonight?"}</div>
            <div className="flex gap-2 mb-3 flex-wrap">
              {MIN_CHIPS.map((m) => (
                <button key={m} onClick={() => logMinutes(m)} disabled={busy} className="touch-target rounded-card bg-cream-raised shadow-tile px-6 py-4 text-2xl font-extrabold active:bg-cream-sunken">
                  {m} min
                </button>
              ))}
            </div>
            <Keypad value={minutes} onChange={setMinutes} maxLength={3} />
            <button
              onClick={() => { const n = parseInt(minutes, 10); if (n > 0) logMinutes(n); }}
              disabled={busy || !minutes}
              className="btn-primary mt-3 w-full py-5 text-3xl disabled:opacity-40"
            >
              {minutes ? `Log ${minutes} ${unit} → done` : "Enter minutes"}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4 min-h-0">
          <div className="flex gap-3 items-center shrink-0">
            <div className="flex-1 rounded-card bg-cream-sunken px-5 py-4 text-2xl font-bold min-h-[64px]">
              {query || <span className="text-ink-faint">Search by title… (e.g. Wizard of Oz)</span>}
            </div>
            <button onClick={runSearch} disabled={busy || query.trim().length < 2} className="btn-primary px-7 py-4 text-2xl disabled:opacity-40">🔍</button>
          </div>
          {results === null && <SoftKeyboard value={query} onChange={setQuery} onDone={runSearch} doneLabel="Search" />}
          <div className="min-h-0 overflow-y-auto flex flex-col gap-2.5 pr-1 max-h-[46vh]">
            {results?.map((r, i) => (
              <button key={i} disabled={busy} onClick={() => startBook(r)} className="tile px-5 py-3 flex items-center gap-4 text-left active:bg-cream-sunken disabled:opacity-50">
                {r.thumbnail ? (
                   
                  <img src={r.thumbnail} alt="" className="w-[52px] h-[76px] rounded-lg object-cover shrink-0 shadow-tile" />
                ) : (
                  <div className="w-[52px] h-[76px] rounded-lg bg-cream-sunken flex items-center justify-center text-2xl shrink-0">📕</div>
                )}
                <div className="min-w-0">
                  <div className="text-2xl font-extrabold truncate">{r.title}</div>
                  <div className="text-lg font-bold text-ink-soft truncate">{r.author ?? "Unknown"}{r.year ? ` · ${r.year}` : ""}</div>
                </div>
              </button>
            ))}
            {results && results.length === 0 && <div className="text-xl font-bold text-ink-faint text-center py-6">Nothing found — try different words.</div>}
          </div>
          <button onClick={() => { setMode("main"); setResults(null); setQuery(""); }} className="btn-soft px-6 py-3 text-xl self-start shrink-0">← Back</button>
        </div>
      )}
    </Modal>
  );
}
