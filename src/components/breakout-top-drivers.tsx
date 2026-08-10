import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { topDrivers as rankDrivers } from "@/lib/breakout-diagnostics";
import type {
  DriverConfidenceLabel,
  SymbolDiagnostic,
  TopDriver,
  TopDrivers,
} from "@/lib/breakout-diagnostics";
import {
  RISK_LEVELS,
  RISK_PROFILES,
  recommendDriverAction,
  recommendDriverActions,
  summariseActions,
  type DriverAction,
  type RiskLevel,
} from "@/lib/breakout-driver-actions";

const ACTION_TONE: Record<DriverAction, string> = {
  prioritise: "border-emerald-500/40 text-emerald-500",
  trade: "border-sky-500/40 text-sky-500",
  downsize: "border-amber-500/40 text-amber-500",
  avoid: "border-red-500/40 text-red-500",
};

const signed = (v: number, digits = 2) => `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
const tone = (v: number) => (v >= 0 ? "text-emerald-500" : "text-red-500");

const CONFIDENCE_VARIANT: Record<DriverConfidenceLabel, "default" | "secondary" | "outline"> = {
  high: "default",
  medium: "secondary",
  low: "outline",
};

function ConfidenceBadge({ d }: { d: TopDriver }) {
  const c = d.confidence;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
        <Badge
          variant={CONFIDENCE_VARIANT[c.label]}
          className="cursor-default text-[10px] font-normal"
          data-testid={`driver-confidence-${d.symbol}`}
        >
          {c.label} conf · {(c.score * 100).toFixed(0)}
        </Badge>
      </TooltipTrigger>
        <TooltipContent className="max-w-64 text-[11px]">
          <ul className="list-disc space-y-0.5 pl-3">
            {c.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function DriverRow({ d, risk }: { d: TopDriver; risk: RiskLevel }) {
  const rec = recommendDriverAction(d, risk);
  return (
    <li className="flex items-baseline justify-between gap-2 border-t border-border/30 py-1 first:border-t-0">
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 truncate text-xs font-medium">
          {d.symbol}
          <ConfidenceBadge d={d} />
          <Badge
            variant="outline"
            className={`text-[10px] font-normal ${ACTION_TONE[rec.action]}`}
            data-testid={`driver-action-${d.symbol}`}
          >
            {rec.action} · {rec.sizeMultiplier.toFixed(2)}×
          </Badge>
        </p>
        <p className="text-[11px] text-muted-foreground">
          {d.confirmedTrades} confirmed ({d.tradeSharePct.toFixed(0)}% of cohort) · avg{" "}
          {signed(d.confirmedAvgReturnPct)} · led by {d.lead}
          {d.gateDriver !== "none" ? ` · gate: ${d.gateDriver}` : ""}
        </p>
        <p className="text-[11px] text-muted-foreground">{rec.reason}</p>
      </div>
      <div className="shrink-0 text-right">
        <p className={`text-xs font-semibold tabular-nums ${tone(d.score)}`}>
          {d.score >= 0 ? "+" : ""}
          {d.score.toFixed(1)}
        </p>
        <p className="text-[11px] text-muted-foreground tabular-nums">
          share {signed(d.contributionPct, 0)} · gap {signed(d.expectancyGapPct)}
        </p>
      </div>
    </li>
  );
}


function Side({
  title,
  rows,
  empty,
  risk,
}: {
  title: string;
  rows: readonly TopDriver[];
  empty: string;
  risk: RiskLevel;
}) {
  return (
    <div className="rounded-md border border-border/40 p-2">
      <p className="text-[11px] font-medium text-muted-foreground">{title}</p>
      {rows.length ? (
        <ul className="mt-1">
          {rows.map((d) => (
            <DriverRow key={d.symbol} d={d} risk={risk} />
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-[11px] text-muted-foreground">{empty}</p>
      )}
    </div>
  );
}

/**
 * Ranks the names moving the confirmed cohort most, blending signed P&L share
 * with the expectancy gap (confirmed − failed average return) so both
 * "traded a lot" and "real signal edge" contributors surface.
 */
export function BreakoutTopDrivers({ drivers }: { drivers: TopDrivers }) {
  if (!drivers.positive.length && !drivers.negative.length) return null;
  return (
    <div className="space-y-2" data-testid="breakout-top-drivers">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium">Top drivers</p>
        <Badge variant="outline" className="text-[10px] font-normal">
          score = P&amp;L share + {drivers.gapWeight}× expectancy gap
        </Badge>
      </div>
      <p className="text-[11px] text-muted-foreground">{drivers.summary}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Side title="Biggest positive" rows={drivers.positive} empty="No net-positive contributors." />
        <Side title="Biggest negative" rows={drivers.negative} empty="No net-negative contributors." />
      </div>
    </div>
  );
}
