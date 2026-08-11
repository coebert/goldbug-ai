// Shared display for the numerical trend-strength score (slope / volatility)
// measured on the slowest selected moving average.

import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { TrendStrength } from "@/lib/market-symbol-history";

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
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className={`${TONE[strength.direction]} tabular-nums`}>
          Trend strength {strength.score > 0 ? "+" : ""}
          {strength.score} · {strength.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs">{explain(strength)}</TooltipContent>
    </Tooltip>
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
