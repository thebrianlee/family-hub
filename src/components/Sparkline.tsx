"use client";

interface SparklineProps {
  points: number[];
  color: string;
  width?: number;
  height?: number;
  bestIndex?: number;
}

export default function Sparkline({ points, color, width = 260, height = 70, bestIndex }: SparklineProps) {
  if (points.length < 2) {
    return (
      <div style={{ width, height }} className="flex items-center justify-end text-xl font-bold text-ink-faint">
        {points.length === 1 ? "One entry — log more!" : "No data yet"}
      </div>
    );
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const pad = 10;
  const xy = points.map((v, i) => {
    const x = pad + (i * (width - pad * 2)) / (points.length - 1);
    const y = height - pad - ((v - min) / range) * (height - pad * 2);
    return [x, y] as const;
  });
  const path = xy.map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");

  return (
    <svg width={width} height={height} className="shrink-0">
      <path d={path} fill="none" stroke={color} strokeWidth={4.5} strokeLinecap="round" strokeLinejoin="round" />
      {xy.map(([x, y], i) => (
        <circle
          key={i}
          cx={x}
          cy={y}
          r={i === bestIndex ? 9 : 4.5}
          fill={i === bestIndex ? "#DE7C5A" : color}
          stroke={i === bestIndex ? "#B85C3E" : "none"}
          strokeWidth={2.5}
        />
      ))}
    </svg>
  );
}
