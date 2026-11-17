"use client";

// One person's row in the household editor (setup wizard and parent settings):
// name, age and "doesn't read yet" for kids, and a palette color.

import { MEMBER_PALETTE } from "@/lib/member-theme";

export const MAX_NAME = 30;

export interface PersonRow {
  key: number;
  name: string;
  age: string;
  preReader: boolean;
  color: string;
}

export default function PersonEditor({
  role,
  index,
  row,
  canRemove,
  onChange,
  onRemove,
  label,
}: {
  role: "kid" | "parent";
  index: number;
  row: PersonRow;
  canRemove: boolean;
  onChange: (row: PersonRow) => void;
  onRemove: () => void;
  /** Label above the name field; defaults to "Kid 1" / "Parent 1". */
  label?: string;
}) {
  const who = label ?? (role === "kid" ? `Kid ${index + 1}` : `Parent ${index + 1}`);
  return (
    <div className="rounded-card bg-cream-raised p-5 shadow-tile grid gap-4" style={{ borderLeft: `8px solid ${row.color}` }}>
      <div className="flex items-end gap-4">
        <label className="block flex-1 text-xl font-bold">
          {who}
          <input
            value={row.name}
            maxLength={MAX_NAME}
            autoComplete="off"
            placeholder="Name"
            onChange={(e) => onChange({ ...row, name: e.target.value })}
            className="mt-2 h-16 w-full rounded-card border border-cream-line bg-cream px-4 text-2xl font-semibold outline-none"
          />
        </label>
        {role === "kid" && (
          <label className="block w-28 text-xl font-bold">
            Age
            <input
              value={row.age}
              inputMode="numeric"
              autoComplete="off"
              maxLength={2}
              onChange={(e) => onChange({ ...row, age: e.target.value.replace(/[^0-9]/g, "") })}
              className="mt-2 h-16 w-full rounded-card border border-cream-line bg-cream px-4 text-2xl font-semibold outline-none"
            />
          </label>
        )}
        {canRemove && (
          <button type="button" onClick={onRemove} className="btn-soft h-16 px-5 text-xl" aria-label={`Remove ${who}`}>
            Remove
          </button>
        )}
      </div>
      {role === "kid" && (
        <label className="flex items-center gap-3 text-xl font-bold text-ink-soft">
          <input
            type="checkbox"
            checked={row.preReader}
            onChange={(e) => onChange({ ...row, preReader: e.target.checked })}
            className="h-7 w-7"
          />
          Doesn&apos;t read yet (bigger pictures, fewer words)
        </label>
      )}
      <div className="flex flex-wrap items-center gap-2.5" role="radiogroup" aria-label={`${who} color`}>
        {MEMBER_PALETTE.map((c) => (
          <button
            key={c.hex}
            type="button"
            role="radio"
            aria-checked={row.color === c.hex}
            aria-label={c.name}
            title={c.name}
            onClick={() => onChange({ ...row, color: c.hex })}
            className={`touch-target w-12 h-12 rounded-full ${row.color === c.hex ? "ring-4 ring-ink ring-offset-2" : ""}`}
            style={{ background: c.hex }}
          />
        ))}
      </div>
    </div>
  );
}
