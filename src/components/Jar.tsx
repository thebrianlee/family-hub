"use client";

// Animated jar that fills toward a goal — smooth springy level transitions
// with a gentle shimmer wave.

interface JarProps {
  value: number;
  target: number;
  fill: string;
  fillSoft: string;
  label?: string;
  width?: number;
}

export default function Jar({ value, target, fill, fillSoft, label, width = 150 }: JarProps) {
  const pct = Math.max(0, Math.min(1, target > 0 ? value / target : 0));
  const height = width * 1.25;
  const innerTop = height * 0.18;
  const innerBottom = height * 0.96;
  const liquidTop = innerBottom - (innerBottom - innerTop) * pct;
  const clipId = `jar-${fill.replace("#", "")}-${width}`;

  return (
    <div className="flex flex-col items-center">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-label={label}>
        <defs>
          <clipPath id={clipId}>
            <path
              d={`M ${width * 0.15} ${height * 0.16}
                  L ${width * 0.15} ${height * 0.88}
                  Q ${width * 0.15} ${height * 0.96} ${width * 0.27} ${height * 0.96}
                  L ${width * 0.73} ${height * 0.96}
                  Q ${width * 0.85} ${height * 0.96} ${width * 0.85} ${height * 0.88}
                  L ${width * 0.85} ${height * 0.16} Z`}
            />
          </clipPath>
        </defs>

        <g clipPath={`url(#${clipId})`}>
          <rect
            x={0}
            y={liquidTop}
            width={width}
            height={height}
            fill={fill}
            style={{ transition: "y 0.8s cubic-bezier(0.34, 1.3, 0.64, 1)" }}
          />
          <ellipse
            className="animate-shimmer"
            cx={width / 2}
            cy={liquidTop}
            rx={width * 0.45}
            ry={6}
            fill={fillSoft}
            opacity={pct > 0 ? 0.9 : 0}
            style={{ transition: "cy 0.8s cubic-bezier(0.34, 1.3, 0.64, 1)" }}
          />
        </g>

        {/* glass outline + lid in warm neutrals */}
        <path
          d={`M ${width * 0.15} ${height * 0.16}
              L ${width * 0.15} ${height * 0.88}
              Q ${width * 0.15} ${height * 0.96} ${width * 0.27} ${height * 0.96}
              L ${width * 0.73} ${height * 0.96}
              Q ${width * 0.85} ${height * 0.96} ${width * 0.85} ${height * 0.88}
              L ${width * 0.85} ${height * 0.16}`}
          fill="none"
          stroke="#C9BCA5"
          strokeWidth={4}
          strokeLinecap="round"
        />
        <rect
          x={width * 0.11}
          y={height * 0.06}
          width={width * 0.78}
          height={height * 0.08}
          rx={6}
          fill="#E4D9C3"
          stroke="#C9BCA5"
          strokeWidth={3}
        />
        <line
          x1={width * 0.22}
          y1={height * 0.24}
          x2={width * 0.22}
          y2={height * 0.7}
          stroke="white"
          strokeWidth={5}
          strokeLinecap="round"
          opacity={0.45}
        />
      </svg>
      {label && <div className="text-2xl font-bold text-ink-soft -mt-1">{label}</div>}
    </div>
  );
}
