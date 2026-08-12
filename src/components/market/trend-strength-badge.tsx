// Shared display for the numerical trend-strength score (slope / volatility)
// measured on the slowest selected moving average.

import {
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RTooltip,
  YAxis,
} from "recharts";

import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  CHART_ROLE,
  TOOLTIP_CONTENT_STYLE,
  TOOLTIP_LABEL_STYLE,
} from "@/lib/chart-palette";
import type { TrendPercentiles } from "@/lib/sma-display";
import type { TrendStrength, TrendStrengthPoint } from "@/lib/market-symbol-history";

const TONE = {
  up: "border-emerald-500/40 text-emerald-500",
  down: "border-destructive/40 text-destructive",
  flat: "border-border text-muted-foreground",
} as const;

function explain(s: TrendStrength) {
  return `${s.period}-day average is moving ${s.slopeAnnualPct >= 0 ? "up" : "down"} ${Math.abs(
    s.slopeAnnualPct,
  ).toFixed(0)}%/yr against ${s.volatilityPct.toFixed(0)}% annual volatility (${s.samples} bars). Score = slope ÷ volatility, scaled to ±100.`;
}

function signed(v: number, digits = 0) {
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}`;
}

function ordinal(p: number) {
  const rem100 = p % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${p}th`;
  const rem10 = p % 10;
  return `${p}${rem10 === 1 ? "st" : rem10 === 2 ? "nd" : rem10 === 3 ? "rd" : "th"}`;
}

export function TrendStrengthBadge({
  strength,
  percentiles,
}: {
  strength: TrendStrength | null;
  /** Rank of this market's slope/vol within the currently compared markets. */
  percentiles?: TrendPercentiles | null;
}) {
  if (!strength) return null;
  const rank = percentiles && percentiles.count > 1 ? percentiles : null;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className={`${TONE[strength.direction]} tabular-nums`}>
              Trend strength {signed(strength.score)} · {strength.label}
            </Badge>
            <span className="text-xs tabular-nums text-muted-foreground">
              slope {signed(strength.slopeAnnualPct)}%/yr
              {rank?.slope != null ? ` (${ordinal(rank.slope)} pct)` : ""} · vol{" "}
              {strength.volatilityPct.toFixed(0)}%/yr
              {rank?.volatility != null ? ` (${ordinal(rank.volatility)} pct)` : ""} ·{" "}
              {strength.period}d basis
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs">
          {explain(strength)}
          {rank && (rank.slope != null || rank.volatility != null)
            ? ` Percentiles rank this market against the ${rank.count} markets you're comparing (100th = highest).`
            : ""}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}



/** Compact meter + numbers for stat grids. */
export function TrendStrengthStat({ strength }: { strength: TrendStrength | null }) {
  return (
    <div className="rounded-lg border border-border/60 bg-surface-2 px-2.5 py-2">
      <dt className="text-muted-foreground">Trend strength</dt>
      <dd className="tabular-nums">
        {strength ? (
          <>
            <span className={strength.direction === "flat" ? "" : TONE[strength.direction]}>
              {strength.score > 0 ? "+" : ""}
              {strength.score}
            </span>
            <span className="ml-1 text-muted-foreground">
              ({strength.slopeAnnualPct >= 0 ? "+" : ""}
              {strength.slopeAnnualPct.toFixed(0)}%/yr ÷ {strength.volatilityPct.toFixed(0)}% vol)
            </span>
          </>
        ) : (
          "—"
        )}
      </dd>
    </div>
  );
}

/** Sparkline of the rolling trend-strength score across the selected window. */
export function TrendStrengthSparkline({
  series,
  className = "h-10 w-full",
}: {
  series: TrendStrengthPoint[];
  className?: string;
}) {
  if (series.length < 3) return null;
  const last = series[series.length - 1].score;
  const stroke =
    last > 10 ? CHART_ROLE.positive : last < -10 ? CHART_ROLE.negative : CHART_ROLE.neutral;
  return (
    <div className={className} aria-label="Trend strength over time">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={series} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <YAxis hide domain={[-100, 100]} />
          <ReferenceLine y={0} {...REFERENCE_LINE} />
          <RTooltip
            contentStyle={TOOLTIP_CONTENT_STYLE}
            labelStyle={TOOLTIP_LABEL_STYLE}
            formatter={(v: number) => [`${v > 0 ? "+" : ""}${v}`, "Trend strength"]}
          />
          <Line
            type="monotone"
            dataKey="score"
            stroke={stroke}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
