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

export function TrendStrengthBadge({ strength }: { strength: TrendStrength | null }) {
  if (!strength) return null;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className={`${TONE[strength.direction]} tabular-nums`}>
          Trend strength {strength.score > 0 ? "+" : ""}
          {strength.score} · {strength.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs">{explain(strength)}</TooltipContent>
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
          <ReferenceLine y={0} stroke={CHART_ROLE.neutral} strokeOpacity={0.35} />
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
