"use client";

// LISTS — multiple named lists (Groceries, Packing, To-Do…), each with
// collapsible sections. Communal, no PIN, no rewards. Skylight-style.

import { useCallback, useEffect, useState } from "react";
import Modal from "@/components/Modal";
import SoftKeyboard from "@/components/SoftKeyboard";

interface Item {
  id: number;
  label: string;
  checked: boolean;
}
interface Section {
  name: string;
  items: Item[];
}
interface NamedList {
  id: number;
  name: string;
  color: string;
  sections: Section[];
  open: number;
  done: number;
}

const LIST_COLORS = ["#7FA576", "#6E9BBD", "#D9A254", "#DE7C5A", "#8A6D9E", "#5E7B86"];

export default function ListsPage() {
  const [lists, setLists] = useState<NamedList[]>([]);
  const [selId, setSelId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [section, setSection] = useState("General");
  const [newListOpen, setNewListOpen] = useState(false);
  const [newListName, setNewListName] = useState("");
  const [newSectionMode, setNewSectionMode] = useState(false);

  const load = useCallback(() => {
    fetch("/api/lists").then((r) => r.json()).then((d) => setLists(d.lists ?? [])).catch(() => {});
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (selId === null && lists.length) {
      // Deep-link: /lists?list=<name|id> opens that list (else the first).
      const p = new URLSearchParams(window.location.search).get("list");
      const match = p
        ? lists.find((l) => String(l.id) === p || l.name.toLowerCase() === p.toLowerCase())
        : null;
      setSelId(match?.id ?? lists[0].id);
    }
  }, [lists, selId]);

  const sel = lists.find((l) => l.id === selId) ?? null;
  const post = async (body: Record<string, unknown>) => {
    const res = await fetch("/api/lists", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) setLists((await res.json()).lists ?? []);
  };
  const addItem = async () => {
    if (!sel || !draft.trim()) return;
    await post({ action: "add_item", listId: sel.id, section: section || "General", label: draft.trim() });
    setDraft("");
    setNewSectionMode(false);
  };
  const createList = async () => {
    if (!newListName.trim()) return;
    await post({ action: "add_list", name: newListName.trim(), color: LIST_COLORS[lists.length % LIST_COLORS.length] });
    setNewListName("");
    setNewListOpen(false);
  };

  const existingSections = sel ? sel.sections.map((s) => s.name) : [];
  const sectionChips = Array.from(new Set(["General", ...existingSections]));

  return (
    <div className="h-full flex flex-col gap-4 min-h-0">
      <header className="flex items-end justify-between shrink-0">
        <div>
          <div className="eyebrow mb-1">Lists</div>
          <h1 className="text-4xl font-extrabold tracking-tight">Family Lists</h1>
        </div>
      </header>

      {/* list tabs */}
      <div className="flex gap-2.5 overflow-x-auto pb-1 shrink-0">
        {lists.map((l) => (
          <button
            key={l.id}
            onClick={() => setSelId(l.id)}
            className="touch-target shrink-0 rounded-card px-6 py-3 text-2xl font-extrabold flex items-center gap-3 shadow-tile"
            style={selId === l.id ? { background: l.color, color: "#fff" } : { background: "#FFFDF8", color: "#5C7078" }}
          >
            {l.name}
            <span className={`rounded-full px-2.5 py-0.5 text-lg ${selId === l.id ? "bg-white/25" : "bg-cream-sunken"}`}>{l.open}</span>
          </button>
        ))}
        <button onClick={() => setNewListOpen(true)} className="touch-target shrink-0 rounded-card px-5 py-3 text-2xl font-extrabold bg-cream-raised text-ink-faint shadow-tile">＋ List</button>
      </div>

      {/* selected list */}
      <div className="flex-1 min-h-0 flex flex-col gap-4">
        <div className="flex-1 min-h-0 overflow-y-auto card px-6 py-5 flex flex-col gap-5">
          {sel && sel.sections.length === 0 && (
            <div className="flex-1 flex items-center justify-center text-2xl font-bold text-ink-faint text-center">Nothing here yet — add something below.</div>
          )}
          {sel?.sections.map((s) => (
            <div key={s.name}>
              <div className="flex items-center gap-3 mb-2">
                <span className="eyebrow" style={{ color: sel.color }}>{s.name}</span>
                <span className="text-lg font-bold text-ink-faint">{s.items.filter((i) => !i.checked).length}</span>
              </div>
              <div className="flex flex-col gap-2">
                {s.items.map((it) => (
                  <div key={it.id} className={`tile px-5 py-3.5 flex items-center gap-4 ${it.checked ? "opacity-55" : ""}`}>
                    <button
                      onClick={() => post({ action: "toggle", id: it.id })}
                      className="touch-target w-11 h-11 rounded-tile shrink-0 flex items-center justify-center text-2xl font-bold"
                      style={it.checked ? { background: sel.color, color: "#fff" } : { background: "#F2EBE0" }}
                      aria-label={it.checked ? `Uncheck ${it.label}` : `Check ${it.label}`}
                    >
                      {it.checked ? "✓" : ""}
                    </button>
                    <span className={`flex-1 text-2xl font-bold ${it.checked ? "line-through text-ink-faint" : ""}`}>{it.label}</span>
                    <button onClick={() => post({ action: "delete_item", id: it.id })} className="touch-target w-10 h-10 rounded-tile text-xl text-ink-faint active:bg-cream-sunken" aria-label={`Remove ${it.label}`}>✕</button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* add bar */}
        {sel && (
          <div className="shrink-0 card px-5 py-4 flex flex-col gap-3">
            <div className="flex gap-2 items-center overflow-x-auto pb-1">
              <span className="eyebrow shrink-0">Add to</span>
              {sectionChips.map((s) => (
                <button
                  key={s}
                  onClick={() => { setSection(s); setNewSectionMode(false); }}
                  className={`touch-target shrink-0 rounded-tile px-4 py-2 text-xl font-extrabold ${section === s && !newSectionMode ? "bg-ink text-cream" : "bg-cream-raised text-ink-soft shadow-tile"}`}
                >
                  {s}
                </button>
              ))}
              <button
                onClick={() => { setNewSectionMode(true); setSection(""); }}
                className={`touch-target shrink-0 rounded-tile px-4 py-2 text-xl font-extrabold ${newSectionMode ? "bg-ink text-cream" : "bg-cream-raised text-ink-faint shadow-tile"}`}
              >
                ＋ Section
              </button>
            </div>
            {newSectionMode && (
              <div className="rounded-tile bg-cream-sunken px-4 py-2 text-xl font-bold">{section || <span className="text-ink-faint">New section name…</span>}</div>
            )}
            <div className="rounded-card bg-cream-sunken px-5 py-3 text-2xl font-bold min-h-[56px]">
              {newSectionMode ? <span className="text-ink-faint">Type the section name, then switch to add items</span> : draft || <span className="text-ink-faint">e.g. Milk, sunscreen…</span>}
            </div>
            <SoftKeyboard
              value={newSectionMode ? section : draft}
              onChange={newSectionMode ? setSection : setDraft}
              onDone={newSectionMode ? () => setNewSectionMode(false) : addItem}
              doneLabel={newSectionMode ? "Set section →" : "Add"}
            />
          </div>
        )}
      </div>

      <Modal open={newListOpen} onClose={() => setNewListOpen(false)} title="New list">
        <div className="flex flex-col gap-4">
          <div className="rounded-card bg-cream-sunken px-5 py-4 text-2xl font-bold min-h-[64px]">
            {newListName || <span className="text-ink-faint">e.g. Beach trip, Costco…</span>}
          </div>
          <SoftKeyboard value={newListName} onChange={setNewListName} onDone={createList} doneLabel="Create list" />
        </div>
      </Modal>
    </div>
  );
}
