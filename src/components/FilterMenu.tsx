"use client";

// Skylight-style Filter dropdown: a small panel of show/hide toggles. Reused on
// every tab (people, completed, meal types…). Anchor it inside a `relative`
// container next to the Filter button.

export interface FilterRow {
  key: string;
  label: string;
  color?: string;
  on: boolean;
  onToggle: () => void;
}

function Switch({ on }: { on: boolean }) {
  return (
    <span
      className={`shrink-0 w-14 h-8 rounded-full flex items-center transition-colors ${on ? "bg-ink justify-end" : "bg-cream-sunken justify-start"}`}
    >
      <span className="w-6 h-6 rounded-full bg-white shadow-tile mx-1" />
    </span>
  );
}

export default function FilterMenu({ open, onClose, rows }: { open: boolean; onClose: () => void; rows: FilterRow[] }) {
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden="true" />
      <div className="absolute right-0 top-full mt-2 z-50 w-[440px] card p-3 flex flex-col gap-1">
        {rows.map((r) => (
          <button
            key={r.key}
            onClick={r.onToggle}
            className="touch-target flex items-center gap-3 px-3 py-3 rounded-tile active:bg-cream-sunken text-left"
          >
            {r.color !== undefined && <span className="w-6 h-6 rounded-full shrink-0" style={{ background: r.color }} />}
            <span className={`flex-1 text-2xl font-bold ${r.on ? "" : "text-ink-faint"}`}>{r.label}</span>
            <Switch on={r.on} />
          </button>
        ))}
      </div>
    </>
  );
}
