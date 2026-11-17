"use client";

// Big-button numeric keypad — PIN entry and Level Up number entry.
// Keys are 96x76px touch targets.

interface KeypadProps {
  value: string;
  onChange: (next: string) => void;
  maxLength?: number;
  allowDecimal?: boolean;
  masked?: boolean;
}

export default function Keypad({ value, onChange, maxLength = 6, allowDecimal = false, masked = false }: KeypadProps) {
  const press = (k: string) => {
    if (k === "⌫") return onChange(value.slice(0, -1));
    if (k === "." && (!allowDecimal || value.includes("."))) return;
    if (value.length >= maxLength) return;
    onChange(value + k);
  };

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", allowDecimal ? "." : "", "0", "⌫"];

  return (
    <div className="flex flex-col items-center gap-5">
      <div className="h-20 min-w-[280px] px-8 rounded-card bg-cream-sunken flex items-center justify-center text-5xl font-extrabold tracking-widest tabular-nums">
        {masked ? "•".repeat(value.length) : value || <span className="text-ink-faint">—</span>}
      </div>
      <div className="grid grid-cols-3 gap-4">
        {keys.map((k, i) =>
          k === "" ? (
            <div key={i} />
          ) : (
            <button
              key={i}
              onClick={() => press(k)}
              className="touch-target w-24 h-[76px] rounded-card bg-cream-raised shadow-tile text-4xl font-bold active:bg-cream-sunken active:scale-95 transition-transform"
            >
              {k}
            </button>
          )
        )}
      </div>
    </div>
  );
}
