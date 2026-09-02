import type { ReactNode } from "react";

/**
 * Numeric typography, in three sizes and nothing else.
 *
 *  headline — the one number a screen is about (equity, today's P&L)
 *  metric   — figures inside a card
 *  body     — inline numbers in prose and tables
 *
 * All variants are tabular-lining so digits stop jittering as prices
 * refresh and columns line up down the page.
 */
export type MetricSize = "headline" | "metric" | "body";
export type MetricTone = "neutral" | "up" | "down" | "muted";

const SIZE: Record<MetricSize, string> = {
  headline: "font-display text-3xl font-semibold tracking-tight sm:text-4xl",
  metric: "font-display text-xl font-semibold tracking-tight",
  body: "text-sm font-medium",
};

const TONE: Record<MetricTone, string> = {
  neutral: "text-foreground",
  up: "text-success",
  down: "text-destructive",
  muted: "text-muted-foreground",
};

export function MetricValue({
  value,
  size = "metric",
  tone = "neutral",
  className = "",
}: {
  value: ReactNode;
  size?: MetricSize;
  tone?: MetricTone;
  className?: string;
}) {
  return <span className={`tabular-nums ${SIZE[size]} ${TONE[tone]} ${className}`}>{value}</span>;
}

/** Label + value pair, the standard unit inside cards and summaries. */
export function Metric({
  label,
  value,
  hint,
  size = "metric",
  tone = "neutral",
  className = "",
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  size?: MetricSize;
  tone?: MetricTone;
  className?: string;
}) {
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5">
        <MetricValue value={value} size={size} tone={tone} />
      </div>
      {hint && <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

/** Responsive row of metrics: 2-up on phones, N-up from `sm:`. */
export function MetricRow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] ${className}`}
    >
      {children}
    </div>
  );
}

/** Tone helper so callers don't re-derive sign colouring everywhere. */
export function toneForDelta(n: number | null | undefined): MetricTone {
  if (n === null || n === undefined || Number.isNaN(n)) return "muted";
  if (n > 0) return "up";
  if (n < 0) return "down";
  return "neutral";
}
