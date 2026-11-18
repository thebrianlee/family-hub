"use client";

// READING — per-kid bookshelf trophy case. Current book hero, stats,
// and a celebratory grid of every finished book. Finish → "Tell me about it".

import { useCallback, useEffect, useState } from "react";
import { KidId } from "@/lib/family";
import { useMembers } from "@/components/MembersProvider";
import { useModules } from "@/components/ModulesProvider";
import KidPicker from "@/components/KidPicker";
import Confetti from "@/components/Confetti";
import Modal from "@/components/Modal";
import SoftKeyboard from "@/components/SoftKeyboard";

interface ShelfBook {
  id: number;
  title: string;
  author: string | null;
  finished_at: string;
  hasNote: boolean;
  cover_path: string | null;
  readDays: number | null;
}

interface ReadingBook {
  id: number;
  title: string;
  author: string | null;
  cover_path: string | null;
  day: number;
}

interface Summary {
  kid: KidId;
  reading: ReadingBook[];
  finishedThisYear: number;
  streak: number;
  shelf: ShelfBook[];
}

interface SearchResult {
  title: string;
  author: string | null;
  isbn: string | null;
  thumbnail: string | null;
  year: string | null;
}

const PROMPTS = [
  "What was your favorite part, and why?",
  "Who was the most interesting character?",
  "What surprised you in this book?",
  "Would you recommend it to a friend? Why?",
  "If you could change the ending, what would happen?",
];

// Deterministic warm spine colors so each cover feels distinct but on-palette.
const COVER_COLORS = ["#6E9BBD", "#7FA576", "#D9A254", "#DE7C5A", "#5E7B86", "#3E6D8F", "#4E7448", "#A0702B"];

function fmtDate(iso: string): string {
  const d = new Date(iso.replace(" ", "T"));
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

export default function ReadingPage() {
  const { kids, memberOf } = useMembers();
  // Finishing a book still earns points with Points & jar off; the line just isn't shown.
  const rewardsOn = useModules().isOn("rewards");
  const [kid, setKid] = useState<KidId | null>(kids[0]?.id ?? null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [celebrate, setCelebrate] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<{ bookId: number; title: string; prompt: string } | null>(null);
  const [answer, setAnswer] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [starting, setStarting] = useState(false);
  const [manual, setManual] = useState(false);
  const [manualField, setManualField] = useState<"title" | "author">("title");
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");

  const load = useCallback((k: KidId) => {
    fetch(`/api/reading?kid=${k}`).then((r) => r.json()).then((d) => setSummary(d.summary)).catch(() => {});
  }, []);

  useEffect(() => {
    if (kid) load(kid);
  }, [kid, load]);

  const post = (payload: Record<string, unknown>) =>
    fetch("/api/reading", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kid, ...payload }),
    });

  const finish = async (book: ReadingBook) => {
    if (!kid) return;
    const res = await post({ action: "finish", bookId: book.id });
    if (!res.ok) return;
    const body = await res.json();
    load(kid);
    const daysBit = body.readDays > 1 ? ` Read in ${body.readDays} days!` : " Read in a single day!";
    setCelebrate(`"${book.title}" goes on the shelf!${daysBit}${rewardsOn ? ` +${body.earned} Family Bucks` : ""}`);
    setTimeout(() => setCelebrate(null), 4200);
    setNoteFor({ bookId: book.id, title: book.title, prompt: PROMPTS[book.id % PROMPTS.length] });
    setAnswer("");
  };

  const removeBook = async (book: ReadingBook) => {
    if (!kid) return;
    await post({ action: "remove", bookId: book.id });
    load(kid);
    setCelebrate(`Took "${book.title}" off the pile.`);
    setTimeout(() => setCelebrate(null), 2200);
  };

  const saveNote = async () => {
    if (!kid || !noteFor || !answer.trim()) return;
    await post({ action: "note", bookId: noteFor.bookId, prompt: noteFor.prompt, answer });
    setNoteFor(null);
    setAnswer("");
    load(kid);
  };

  const runSearch = async () => {
    if (query.trim().length < 2) return;
    setSearching(true);
    try {
      const res = await fetch(`/api/books/search?q=${encodeURIComponent(query.trim())}`);
      const body = await res.json();
      setResults(body.results ?? []);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const closeNew = () => {
    setNewOpen(false);
    setQuery("");
    setResults(null);
    setManual(false);
    setTitle("");
    setAuthor("");
  };

  const startFromResult = async (r: SearchResult) => {
    if (!kid || starting) return;
    setStarting(true);
    try {
      const res = await post({ action: "start", title: r.title, author: r.author, isbn: r.isbn, coverUrl: r.thumbnail });
      closeNew();
      load(kid);
      if (res.ok) {
        setCelebrate(`"${r.title}" added — Day 1 starts now! 📖`);
        setTimeout(() => setCelebrate(null), 3200);
      }
    } finally {
      setStarting(false);
    }
  };

  const startManual = async () => {
    if (!kid || !title.trim()) return;
    await post({ action: "start", title, author: author || null });
    closeNew();
    load(kid);
  };

  const theme = kid ? memberOf(kid).theme : null;

  return (
    <div className="h-full flex flex-col gap-6 min-h-0">
      {celebrate && (
        <>
          <Confetti />
          <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 card bg-cream-raised px-12 py-6 text-4xl font-extrabold animate-pop-in">
            📚 {celebrate}
          </div>
        </>
      )}

      <header className="shrink-0">
        <div className="eyebrow mb-2">Reading</div>
        <h1 className="text-6xl font-extrabold tracking-tight">
          {kid ? `${memberOf(kid).name}'s Bookshelf` : "Bookshelf"}
        </h1>
      </header>

      <KidPicker selected={kid} onSelect={setKid} />

      {/* Now Reading stack + stats */}
      <div className="card px-8 py-6 shrink-0">
        <div className="flex items-center justify-between mb-4">
          <div className="eyebrow">
            📖 Now Reading {summary && summary.reading.length > 0 ? `— ${summary.reading.length} on the go` : ""}
          </div>
          <div className="flex gap-4 items-center">
            <span className="well px-5 py-2 text-2xl font-extrabold">
              <span className={theme?.text ?? ""}>{summary?.finishedThisYear ?? 0}</span>
              <span className="text-lg font-bold text-ink-soft"> this year</span>
            </span>
            <span className="well px-5 py-2 text-2xl font-extrabold">
              🔥{summary?.streak ?? 0}
              <span className="text-lg font-bold text-ink-soft"> day streak</span>
            </span>
            <button
              onClick={() => setNewOpen(true)}
              className={`touch-target rounded-card ${theme?.bg ?? "bg-ink"} text-white px-6 py-3 text-2xl font-extrabold active:scale-95 transition-transform`}
            >
              + Start a Book
            </button>
          </div>
        </div>
        {summary && summary.reading.length === 0 ? (
          <div className="text-3xl font-bold text-ink-faint py-6 text-center">
            No book on the go — start one and the clock starts ticking!
          </div>
        ) : (
          <div className="flex gap-5 overflow-x-auto pb-1">
            {(summary?.reading ?? []).map((b) => (
              <div key={b.id} className="tile shrink-0 w-[430px] p-4 flex gap-4 items-center">
                {b.cover_path ? (
                   
                  <img src={b.cover_path} alt="" className="w-[92px] h-[128px] shrink-0 rounded-lg shadow-tile object-cover" />
                ) : (
                  <div
                    className={`w-[92px] h-[128px] shrink-0 rounded-lg ${theme?.bg ?? "bg-ink"} flex items-center justify-center text-3xl`}
                  >
                    📖
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-2xl font-extrabold leading-tight line-clamp-2">{b.title}</div>
                  <div className={`text-xl font-extrabold mt-1 ${theme?.text ?? ""}`}>Day {b.day}</div>
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={() => finish(b)}
                      className={`touch-target rounded-tile ${theme?.bg ?? "bg-ink"} text-white px-4 py-2.5 text-xl font-extrabold active:scale-95 transition-transform`}
                    >
                      ✓ Finished!
                    </button>
                    <button
                      onClick={() => removeBook(b)}
                      className="touch-target rounded-tile bg-cream-sunken text-ink-faint px-3 py-2.5 text-xl font-bold active:bg-cream-line"
                      aria-label={`Remove ${b.title}`}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Trophy shelf */}
      <div className="flex-1 min-h-0 card px-8 py-6 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between mb-5 shrink-0">
          <div className="eyebrow">🏆 The Trophy Shelf — {summary?.shelf.length ?? 0} books strong</div>
        </div>
        {summary && summary.shelf.length === 0 && (
          <div className="flex-1 flex items-center justify-center text-3xl font-bold text-ink-faint">
            Finish your first book to start the collection!
          </div>
        )}
        <div className="grid grid-cols-4 gap-6 content-start overflow-hidden">
          {(summary?.shelf ?? []).slice(0, 8).map((b) =>
            b.cover_path ? (
              <div key={b.id} className="flex flex-col items-center animate-pop-in">
                <div className="relative w-full aspect-[3/4] rounded-tile shadow-card overflow-hidden">
                  { }
                  <img src={b.cover_path} alt={b.title} className="absolute inset-0 w-full h-full object-cover" />
                  <div className="absolute bottom-0 inset-x-0 bg-ink-deep/70 px-3 py-1.5 flex items-center justify-between">
                    <span className="text-white/90 text-lg font-bold">
                      {fmtDate(b.finished_at)}
                      {b.readDays ? ` · ${b.readDays}d` : ""}
                    </span>
                    {b.hasNote && <span className="text-lg">💬</span>}
                  </div>
                </div>
              </div>
            ) : (
            <div key={b.id} className="flex flex-col items-center animate-pop-in">
              <div
                className="w-full aspect-[3/4] rounded-tile shadow-card flex flex-col items-center justify-between p-5 text-center"
                style={{ backgroundColor: COVER_COLORS[b.id % COVER_COLORS.length] }}
              >
                <span className="text-4xl">{b.hasNote ? "💬" : "📕"}</span>
                <span className="text-white text-2xl font-extrabold leading-tight line-clamp-4">{b.title}</span>
                <span className="text-white/80 text-lg font-bold">{fmtDate(b.finished_at)}</span>
              </div>
            </div>
            )
          )}
        </div>
        {summary && summary.shelf.length > 8 && (
          <div className="mt-4 text-center text-2xl font-bold text-ink-faint shrink-0">
            + {summary.shelf.length - 8} more in the collection
          </div>
        )}
      </div>

      {/* Tell me about it */}
      <Modal open={noteFor !== null} onClose={() => setNoteFor(null)} title="💬 Tell me about it" wide>
        {noteFor && (
          <div className="flex flex-col gap-4">
            <div className="text-3xl font-extrabold leading-snug">{noteFor.prompt}</div>
            <div className="w-full rounded-card bg-cream-sunken p-5 text-2xl font-bold min-h-[110px]">
              {answer || <span className="text-ink-faint">Tell us what you thought…</span>}
            </div>
            <SoftKeyboard value={answer} onChange={setAnswer} onDone={saveNote} doneLabel="Save" />
            <button onClick={() => setNoteFor(null)} className="btn-soft px-10 py-3 text-xl self-center">
              Skip for now
            </button>
          </div>
        )}
      </Modal>

      {/* Start book — search first, manual fallback */}
      <Modal open={newOpen} onClose={closeNew} title="📖 Start a Book" wide>
        <div className="flex flex-col gap-4 min-h-0">
          {!manual ? (
            <>
              <div className="flex gap-3 shrink-0 items-center">
                <div className="flex-1 rounded-card bg-cream-sunken p-5 text-3xl font-bold min-h-[76px]">
                  {query || <span className="text-ink-faint">Search by title… (e.g. Wizard of Oz)</span>}
                </div>
                <button
                  onClick={runSearch}
                  disabled={searching || query.trim().length < 2}
                  className="btn-primary px-8 py-5 text-2xl disabled:opacity-40"
                >
                  {searching ? "…" : "🔍 Search"}
                </button>
              </div>
              {results === null && (
                <SoftKeyboard value={query} onChange={setQuery} onDone={runSearch} doneLabel="Search" />
              )}
              <div className="min-h-0 overflow-y-auto flex flex-col gap-3 pr-1 max-h-[48vh]">
                {results?.map((r, i) => (
                  <button
                    key={i}
                    disabled={starting}
                    onClick={() => startFromResult(r)}
                    className="tile px-5 py-4 flex items-center gap-5 text-left active:bg-cream-sunken disabled:opacity-50"
                  >
                    {r.thumbnail ? (
                       
                      <img src={r.thumbnail} alt="" className="w-[64px] h-[92px] rounded-lg object-cover shrink-0 shadow-tile" />
                    ) : (
                      <div className="w-[64px] h-[92px] rounded-lg bg-cream-sunken flex items-center justify-center text-3xl shrink-0">
                        📕
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="text-2xl font-extrabold truncate">{r.title}</div>
                      <div className="text-xl font-bold text-ink-soft truncate">
                        {r.author ?? "Unknown author"}
                        {r.year ? ` · ${r.year}` : ""}
                      </div>
                    </div>
                  </button>
                ))}
                {results && results.length === 0 && (
                  <div className="text-2xl font-bold text-ink-faint text-center py-6">
                    Nothing found — try different words or add it manually.
                  </div>
                )}
              </div>
              <div className="flex gap-3 justify-center shrink-0">
                {results !== null && (
                  <button
                    onClick={() => {
                      setResults(null);
                      setQuery("");
                    }}
                    className="btn-soft px-6 py-3 text-xl"
                  >
                    ↩ New search
                  </button>
                )}
                <button onClick={() => setManual(true)} className="btn-soft px-6 py-3 text-xl">
                  Can&apos;t find it? Add manually
                </button>
              </div>
            </>
          ) : (
            <>
              <button
                onClick={() => setManualField("title")}
                className={`w-full text-left rounded-card p-5 text-3xl font-bold min-h-[72px] ${
                  manualField === "title" ? "bg-cream-sunken ring-2 ring-ink-faint" : "bg-cream-sunken/60"
                }`}
              >
                {title || <span className="text-ink-faint">Book title</span>}
              </button>
              <button
                onClick={() => setManualField("author")}
                className={`w-full text-left rounded-card p-5 text-3xl font-bold min-h-[72px] ${
                  manualField === "author" ? "bg-cream-sunken ring-2 ring-ink-faint" : "bg-cream-sunken/60"
                }`}
              >
                {author || <span className="text-ink-faint">Author (optional)</span>}
              </button>
              <SoftKeyboard
                value={manualField === "title" ? title : author}
                onChange={manualField === "title" ? setTitle : setAuthor}
                onDone={startManual}
                doneLabel="Start"
              />
              <button onClick={() => setManual(false)} className="btn-soft px-8 py-3 text-xl self-center">
                Back to search
              </button>
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}
