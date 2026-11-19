"use client";

// One switch card per built-in module (src/modules/registry.ts), for the
// first-run wizard and Settings → Modules. Each card says what the module does
// and, when it sends anything a child typed off the hub, where it goes, in
// plain words (the enable dialog in docs/architecture/skills.md).

import { TOGGLEABLE_MODULES, getModule, type ModuleState } from "@/modules/registry";

// sendsChildDataTo in plain words, per module.
const CHILD_DATA_NOTE: Record<string, string> = {
  ask: "Questions your kids type are sent to the AI you connect.",
};

/** "A or B": who receives child data. */
function recipients(list: readonly string[]): string {
  return list.length <= 1 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} or ${list[list.length - 1]}`;
}

export default function ModuleToggles({
  state,
  onToggle,
  firstRun = false,
  busy = false,
}: {
  state: ModuleState;
  onToggle: (id: string, on: boolean) => void;
  /** The wizard: modules that start off say so. */
  firstRun?: boolean;
  busy?: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-4">
      {TOGGLEABLE_MODULES.map((m) => {
        const on = state[m.id] ?? m.defaultEnabled;
        const needs = (m.dependsOn ?? []).map((id) => getModule(id)?.name ?? id);
        return (
          <button
            key={m.id}
            type="button"
            role="switch"
            aria-checked={on}
            disabled={busy}
            onClick={() => onToggle(m.id, !on)}
            className={`touch-target flex flex-col justify-start rounded-card px-6 py-5 text-left shadow-tile transition-colors disabled:opacity-60 ${
              on ? "bg-ink text-cream" : "bg-cream-raised text-ink active:bg-cream-sunken"
            }`}
          >
            <span className="flex items-start justify-between gap-3">
              <span className="text-2xl font-extrabold leading-tight">{m.name}</span>
              <span
                className={`shrink-0 rounded-full px-3 py-1 text-lg font-extrabold ${
                  on ? "bg-cream text-ink" : "bg-cream-sunken text-ink-soft"
                }`}
              >
                {on ? "On" : "Off"}
              </span>
            </span>
            <span className={`mt-2 block text-xl leading-snug ${on ? "text-cream/80" : "text-ink-soft"}`}>{m.description}</span>
            {needs.length > 0 && (
              <span className={`mt-2 block text-lg font-bold ${on ? "text-cream/70" : "text-ink-faint"}`}>
                Needs {needs.join(" and ")}.
              </span>
            )}
            {m.sendsChildDataTo.length > 0 && (
              <span className={`mt-2 block text-lg font-bold leading-snug ${on ? "text-cream" : "text-ember-deep"}`}>
                {CHILD_DATA_NOTE[m.id] ?? "What your kids enter here is sent outside the hub."}
                {firstRun && !m.defaultEnabled ? " Off until you turn it on." : ""}
                <span className={`block font-semibold ${on ? "text-cream/70" : "text-ink-faint"}`}>
                  Sent to: {recipients(m.sendsChildDataTo)}.
                </span>
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
