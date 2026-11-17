"use client";

// In-app touch keyboard — the wall has no physical or OS keyboard, so every
// text field pairs with this. Big kid-friendly keys, token-styled.

interface SoftKeyboardProps {
  value: string;
  onChange: (next: string) => void;
  onDone?: () => void;
  doneLabel?: string;
  /** show a strip of common emoji (for checklist/meal editors) */
  emojiRow?: boolean;
}

const ROWS = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
  ["A", "S", "D", "F", "G", "H", "J", "K", "L", "'"],
  ["Z", "X", "C", "V", "B", "N", "M", ",", "-", "!"],
];

const EMOJI = ["🪥", "🛏️", "📖", "⚽", "✏️", "🧸", "👕", "🍽️", "🌮", "🍕", "🍝", "🥘", "🍗", "🍔", "💛", "🙌"];

export default function SoftKeyboard({ value, onChange, onDone, doneLabel = "Done", emojiRow = false }: SoftKeyboardProps) {
  // Sentence-case typing: letters are uppercase at the start of a word.
  const press = (k: string) => {
    const isLetter = k.length === 1 && /[A-Z]/.test(k);
    const atWordStart = value === "" || value.endsWith(" ");
    onChange(value + (isLetter && !atWordStart ? k.toLowerCase() : k));
  };

  return (
    <div className="flex flex-col gap-2 select-none">
      {emojiRow && (
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {EMOJI.map((e) => (
            <button
              key={e}
              onClick={() => press(e)}
              className="touch-target shrink-0 w-[68px] h-[58px] rounded-tile bg-cream-raised shadow-tile text-3xl active:bg-cream-sunken"
            >
              {e}
            </button>
          ))}
        </div>
      )}
      {ROWS.map((row, i) => (
        <div key={i} className="flex gap-1.5 justify-center">
          {row.map((k) => (
            <button
              key={k}
              onClick={() => press(k)}
              className="touch-target flex-1 max-w-[110px] h-[64px] rounded-tile bg-cream-raised shadow-tile text-3xl font-bold active:bg-cream-sunken active:scale-95 transition-transform"
            >
              {k}
            </button>
          ))}
        </div>
      ))}
      <div className="flex gap-1.5 justify-center">
        <button
          onClick={() => onChange(value.slice(0, -1))}
          className="touch-target w-[160px] h-[64px] rounded-tile bg-cream-sunken text-3xl font-bold active:bg-cream-line"
        >
          ⌫
        </button>
        <button
          onClick={() => press(" ")}
          className="touch-target flex-1 max-w-[560px] h-[64px] rounded-tile bg-cream-raised shadow-tile text-2xl font-bold text-ink-faint active:bg-cream-sunken"
        >
          space
        </button>
        <button
          onClick={() => onChange("")}
          className="touch-target w-[130px] h-[64px] rounded-tile bg-cream-sunken text-2xl font-bold text-ink-soft active:bg-cream-line"
        >
          Clear
        </button>
        {onDone && (
          <button onClick={onDone} className="touch-target w-[200px] h-[64px] rounded-card bg-ink text-cream text-2xl font-extrabold active:scale-95 transition-transform">
            {doneLabel}
          </button>
        )}
      </div>
    </div>
  );
}
