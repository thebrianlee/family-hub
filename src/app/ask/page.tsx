"use client";

// ASK — the kids' answer wall as a first-class tab. Pick your face to ask,
// and browse everything the family has asked (parent-reviewable archive).

import { useCallback, useEffect, useState } from "react";
import { KidId } from "@/lib/family";
import { useMembers } from "@/components/MembersProvider";
import Avatar from "@/components/Avatar";
import AskSheet from "@/components/AskSheet";

interface KidQuestion {
  id: number;
  kid: string;
  question: string;
  answer: string;
  source: string;
  created_at: string;
}

function when(iso: string): string {
  const d = new Date(iso.replace(" ", "T"));
  if (isNaN(d.getTime())) return "";
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** Three across for the sample family, up to four for bigger ones. */
function kidColumns(n: number): number {
  return Math.max(1, Math.min(n, 4));
}

export default function AskPage() {
  const { kids } = useMembers();
  const [questions, setQuestions] = useState<KidQuestion[]>([]);
  const [askOpen, setAskOpen] = useState(false);
  const [askKid, setAskKid] = useState<KidId | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = useCallback(() => {
    fetch("/api/ask?limit=50").then((r) => r.json()).then((d) => setQuestions(d.questions ?? [])).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const openFor = (kid: KidId) => { setAskKid(kid); setAskOpen(true); };

  return (
    <div className="h-full flex flex-col gap-5 min-h-0">
      <header className="shrink-0">
        <div className="eyebrow mb-1">Ask</div>
        <h1 className="text-4xl font-extrabold tracking-tight">What do you want to know?</h1>
      </header>

      {/* Who's asking — tap your face */}
      <div className="grid gap-5 shrink-0" style={{ gridTemplateColumns: `repeat(${kidColumns(kids.length)}, minmax(0, 1fr))` }}>
        {kids.map((k) => (
          <button key={k.id} onClick={() => openFor(k.id)} className={`card ${k.theme.bgSoft} p-6 flex flex-col items-center gap-3 active:opacity-90`}>
            <Avatar member={k.id} size={104} />
            <span className={`text-3xl font-extrabold ${k.theme.textDeep}`}>{k.name}</span>
            <span className="rounded-full bg-cream-raised px-4 py-1.5 text-lg font-bold text-ink-soft">💡 Ask something</span>
          </button>
        ))}
      </div>

      {/* The archive */}
      <div className="flex-1 min-h-0 flex flex-col gap-3">
        <div className="eyebrow shrink-0">Everything we&apos;ve asked</div>
        {questions.length === 0 ? (
          <div className="card px-8 py-12 text-center text-2xl font-bold text-ink-faint">
            No questions yet — tap your face and ask the first one!
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-2.5 pb-1">
            {questions.map((q) => {
              const isOpen = expanded === q.id;
              return (
                <button
                  key={q.id}
                  onClick={() => setExpanded(isOpen ? null : q.id)}
                  className="card px-6 py-4 text-left active:bg-cream-sunken"
                >
                  <div className="flex items-center gap-4">
                    <Avatar member={q.kid} size={48} />
                    <span className="flex-1 min-w-0 text-2xl font-extrabold leading-tight">{q.question}</span>
                    <span className="shrink-0 text-lg font-bold text-ink-faint">{when(q.created_at)}</span>
                    <span className={`shrink-0 text-xl text-ink-faint transition-transform ${isOpen ? "rotate-90" : ""}`}>›</span>
                  </div>
                  {isOpen && (
                    <div className="mt-3 pl-16 text-xl font-bold text-ink-soft leading-relaxed whitespace-pre-wrap">
                      {q.answer}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <AskSheet open={askOpen} onClose={() => { setAskOpen(false); setAskKid(null); }} onAsked={load} initialKid={askKid} />
    </div>
  );
}
