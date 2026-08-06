import { sparklineDomain } from "@/lib/sparkline-scale";

interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
  /**
   * Let the drawing fill its container instead of keeping the 120x36 aspect
   * ratio. Without this the SVG is letterboxed inside a wide column, which
   * leaves large empty margins either side of the line.
   */
  stretch?: boolean;
  /** Optional accessible label describing the series. */
  label?: string;
  /**
   * Explicit y-domain. Supplied by callers that also print axis labels, so the
   * drawn line and the printed numbers cannot disagree. Defaults to the
   * shared padded/nice domain from `sparklineDomain`.
   */
  domain?: { min: number; max: number };
}

/**
 * Compact SVG sparkline showing recent trend of a numeric series.
 * Colors itself based on net change (positive → primary, negative → destructive).
 */
export function Sparkline({
  values,
  width = 120,
  height = 36,
  className,
  stretch = false,
  label,
  domain,
}: SparklineProps) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length < 2) {
    return (
      <div
        className={className}
        style={stretch ? undefined : { width, height }}
        aria-label="Not enough data for trend"
      />
    );
  }
  const scale = domain ?? sparklineDomain(clean);
  const min = scale.min;
  const max = scale.max;
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
      width={stretch ? "100%" : width}
      height={stretch ? "100%" : height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio={stretch ? "none" : undefined}
      className={className}
      role="img"
      aria-label={label ?? `Trend ${up ? "up" : "down"}`}
    >
      <defs>
        <linearGradient id={areaId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity={0.35} />
          <stop offset="100%" stopColor={stroke} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={areaD} fill={`url(#${areaId})`} />
      <path d={pathD} fill="none" stroke={stroke} strokeWidth={1.5}
        vectorEffect={stretch ? "non-scaling-stroke" : undefined}
        strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
