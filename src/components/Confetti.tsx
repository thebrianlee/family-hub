"use client";

// Refined confetti burst — token colors, brief, springy. Deterministic
// layout (no Math.random in render) so it's SSR-safe.

const COLORS = ["#6E9BBD", "#7FA576", "#D9A254", "#DE7C5A", "#5E7B86"];

const PIECES = Array.from({ length: 32 }, (_, i) => {
  const hash = (i * 2654435761) % 1000;
  return {
    left: hash % 100,
    delay: (hash % 6) * 0.09,
    duration: 1.9 + (hash % 9) / 10,
    color: COLORS[i % COLORS.length],
    size: 9 + (hash % 10),
    round: i % 3 === 0,
  };
});

export default function Confetti() {
  return (
    <div className="pointer-events-none fixed inset-0 z-50 overflow-hidden">
      {PIECES.map((p, i) => (
        <div
          key={i}
          className={`absolute top-0 animate-confetti ${p.round ? "rounded-full" : "rounded-[3px]"}`}
          style={{
            left: `${p.left}%`,
            width: p.size,
            height: p.round ? p.size : p.size * 0.55,
            backgroundColor: p.color,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.duration}s`,
          }}
        />
      ))}
    </div>
  );
}
