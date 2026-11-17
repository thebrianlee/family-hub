"use client";

// ASK THE HUB — the kids' answer wall. Pick your face, type a question, get a
// kid-tuned answer (Claude via the Mac mini bridge; local Ollama fallback).
// Mic button is a visible placeholder until the USB mic arrives.

import { useEffect, useState } from "react";
import { KidId } from "@/lib/family";
import { useMembers } from "./MembersProvider";
import Avatar from "./Avatar";
import Modal from "./Modal";
import SoftKeyboard from "./SoftKeyboard";

const THINKING = ["Thinking really hard…", "Asking my brain…", "Ooh, good one…", "Let me figure that out…"];

export default function AskSheet({ open, onClose, onAsked, initialKid }: {
  open: boolean;
  onClose: () => void;
  onAsked?: () => void;
  initialKid?: KidId | null;
}) {
  const { kids } = useMembers();
  const [kid, setKid] = useState<KidId | null>(null);
  useEffect(() => { if (open && initialKid) setKid(initialKid); }, [open, initialKid]);
  const [draft, setDraft] = useState("");
  const [phase, setPhase] = useState<"ask" | "loading" | "answer" | "error">("ask");
  const [answer, setAnswer] = useState("");
  const [errMsg, setErrMsg] = useState("");
  const [asked, setAsked] = useState("");

  const reset = () => { setDraft(""); setPhase("ask"); setAnswer(""); setErrMsg(""); };
  const close = () => { reset(); setKid(null); onClose(); };

  const submit = async () => {
    const q = draft.trim();
    if (!q || !kid) return;
    setAsked(q);
    setPhase("loading");
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kid, question: q }),
      });
      const data = await res.json();
      if (!res.ok) { setErrMsg(data.error ?? "Something went wrong."); setPhase("error"); return; }
      setAnswer(data.answer);
      setPhase("answer");
      onAsked?.();
    } catch {
      setErrMsg("My brain helper isn't answering right now. Try again in a little bit!");
      setPhase("error");
    }
  };

  return (
    <Modal open={open} onClose={close} title="Ask the Hub" wide>
      {/* Step 1: who's asking */}
      {!kid && (
        <div className="flex flex-col items-center gap-6 py-4">
          <div className="text-3xl font-extrabold">Who&apos;s asking?</div>
          <div className="flex flex-wrap justify-center gap-6">
            {kids.map((k) => (
              <button key={k.id} onClick={() => setKid(k.id)} className="touch-target card p-6 flex flex-col items-center gap-3 active:bg-cream-sunken">
                <Avatar member={k.id} size={110} />
                <span className={`text-3xl font-extrabold ${k.theme.textDeep}`}>{k.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Step 2: the question */}
      {kid && phase === "ask" && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Avatar member={kid} size={52} />
            <span className="text-2xl font-extrabold">What do you want to know?</span>
            {/* Mic — hardware not installed yet; visible so kids know it's coming */}
            <span className="ml-auto relative">
              <button disabled aria-label="Voice input coming soon" className="w-16 h-16 rounded-full bg-cream-sunken text-3xl opacity-45">🎤</button>
              <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 rounded-full bg-cream-line px-2 py-0.5 text-[11px] font-bold text-ink-faint whitespace-nowrap">soon</span>
            </span>
          </div>
          <div className="rounded-card bg-cream-sunken px-5 py-4 text-2xl font-bold min-h-[64px]">
            {draft || <span className="text-ink-faint">Why is the sky blue?…</span>}
          </div>
          <SoftKeyboard value={draft} onChange={setDraft} onDone={submit} doneLabel="Ask! ✨" />
        </div>
      )}

      {/* Step 3: thinking */}
      {kid && phase === "loading" && (
        <div className="flex flex-col items-center gap-6 py-10">
          <div className="text-7xl animate-bounce">🤔</div>
          <div className="text-3xl font-extrabold text-ink-soft">{THINKING[asked.length % THINKING.length]}</div>
          <div className="text-xl font-bold text-ink-faint">&ldquo;{asked}&rdquo;</div>
        </div>
      )}

      {/* Step 4: the answer */}
      {kid && (phase === "answer" || phase === "error") && (
        <div className="flex flex-col gap-5">
          <div className="flex items-center gap-3">
            <Avatar member={kid} size={44} />
            <span className="text-xl font-bold text-ink-soft">{asked}</span>
          </div>
          <div className="card px-7 py-6 text-3xl font-bold leading-relaxed whitespace-pre-wrap">
            {phase === "answer" ? answer : errMsg}
          </div>
          <div className="flex gap-3 justify-center">
            <button onClick={reset} className="btn-primary px-8 py-4 text-2xl">Ask another</button>
            <button onClick={close} className="btn-soft px-8 py-4 text-2xl">All done</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
