interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
}

/**
 * Compact SVG sparkline showing recent trend of a numeric series.
 * Colors itself based on net change (positive → primary, negative → destructive).
 */
export function Sparkline({ values, width = 120, height = 36, className }: SparklineProps) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length < 2) {
    return (
      <div
        className={className}
        style={{ width, height }}
        aria-label="Not enough data for trend"
      />
    );
  }
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const span = max - min || 1;
  const stepX = width / (clean.length - 1);
  const points = clean.map((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / span) * height;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const first = clean[0];
  const last = clean[clean.length - 1];
  const up = last >= first;
  // Light, high-contrast tones that pop against the dark card background
  const stroke = up ? "#4ade80" : "#f87171"; // emerald-400 / red-400
  const areaId = `spark-${up ? "up" : "dn"}-${clean.length}`;
  const pathD = `M${points.join(" L")}`;
  const areaD = `${pathD} L${width},${height} L0,${height} Z`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      role="img"
      aria-label={`Trend ${up ? "up" : "down"}`}
    >
      <defs>
        <linearGradient id={areaId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity={0.35} />
          <stop offset="100%" stopColor={stroke} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={areaD} fill={`url(#${areaId})`} />
      <path d={pathD} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
