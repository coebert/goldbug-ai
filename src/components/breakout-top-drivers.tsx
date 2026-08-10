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
import {
  DEFAULT_GAP_WEIGHTS,
  findExecutionCell,
  type ExecutionGrid,
} from "@/lib/breakout-driver-execution";

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

const pp = (v: number, digits = 1) => `${v >= 0 ? "+" : ""}${v.toFixed(digits)}pp`;

/**
 * The measured consequence of the two controls: the confirmed cohort replayed
 * with each symbol sized at its recommended multiplier, against the flat-1
 * baseline on exactly the same signals.
 */
function ExecutionImpact({
  cell,
  grid,
}: {
  cell: ReturnType<typeof findExecutionCell> & object;
  grid: ExecutionGrid;
}) {
  const b = grid.baseline;
  const rows: [string, string, string, number][] = [
    [
      "Compounded",
      `${signed(b.cumulativeReturnPct, 1)}`,
      `${signed(cell.cumulativeReturnPct, 1)}`,
      cell.vsBaseline.cumulativeReturnPp,
    ],
    [
      "Avg / signal",
      signed(b.avgReturnPct),
      signed(cell.avgReturnPct),
      cell.vsBaseline.avgReturnPp,
    ],
    [
      "Max drawdown",
      `${b.maxDrawdownPct.toFixed(1)}%`,
      `${cell.maxDrawdownPct.toFixed(1)}%`,
      cell.vsBaseline.maxDrawdownPp,
    ],
    [
      "Capital deployed",
      `${b.deployedPct.toFixed(0)}%`,
      `${cell.deployedPct.toFixed(0)}%`,
      cell.vsBaseline.deployedPp,
    ],
  ];

  return (
    <div className="rounded-md border border-border/40 p-2" data-testid="driver-execution-impact">
      <p className="text-[11px] font-medium text-muted-foreground">
        Backtest at these settings — {cell.taken}/{cell.signals} confirmed signals taken, avg size{" "}
        {cell.avgSize.toFixed(2)}×, win rate {cell.winRatePct.toFixed(1)}%
      </p>
      <table className="mt-1 w-full text-xs">
        <thead className="text-[11px] text-muted-foreground">
          <tr>
            <th className="py-1 text-left font-normal">Metric</th>
            <th className="py-1 text-right font-normal">Flat 1×</th>
            <th className="py-1 text-right font-normal">Sized</th>
            <th className="py-1 text-right font-normal">Δ</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, base, sized, delta]) => (
            <tr key={label} className="border-t border-border/30">
              <td className="py-1">{label}</td>
              <td className="py-1 text-right tabular-nums text-muted-foreground">{base}</td>
              <td className="py-1 text-right tabular-nums">{sized}</td>
              <td className={`py-1 text-right tabular-nums ${tone(delta)}`}>{pp(delta)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-[11px] text-muted-foreground">{grid.summary}</p>
    </div>
  );
}



/**
 * Ranks the names moving the confirmed cohort most, blending signed P&L share
 * with the expectancy gap (confirmed − failed average return) so both
 * "traded a lot" and "real signal edge" contributors surface.
 *
 * Two live controls: the expectancy-gap weight re-ranks the drivers, and the
 * risk setting re-maps each ranked row to a recommended action and size.
 */
export function BreakoutTopDrivers({
  drivers,
  symbols,
  execution,
}: {
  drivers: TopDrivers;
  symbols?: readonly SymbolDiagnostic[];
  execution?: ExecutionGrid;
}) {
  // Snap the slider to the weights the backtest was actually replayed at, so
  // the execution numbers below always match the ranking above.
  const weights = execution?.gapWeights?.length ? execution.gapWeights : [...DEFAULT_GAP_WEIGHTS];
  const initialIdx = Math.max(
    0,
    weights.findIndex((w) => w === drivers.gapWeight),
  );
  const [weightIdx, setWeightIdx] = useState(initialIdx);
  const gapWeight = weights[Math.min(weightIdx, weights.length - 1)] ?? drivers.gapWeight;
  const setGapWeight = (i: number) => setWeightIdx(i);
  const [risk, setRisk] = useState<RiskLevel>("balanced");

  const view = useMemo(() => {
    if (!symbols?.length || gapWeight === drivers.gapWeight) return drivers;
    return rankDrivers(symbols, { gapWeight });
  }, [symbols, gapWeight, drivers]);

  const recs = useMemo(
    () => recommendDriverActions([...view.positive, ...view.negative], risk),
    [view, risk],
  );

  const cell = execution ? findExecutionCell(execution, risk, gapWeight) : null;

  if (!view.positive.length && !view.negative.length) return null;
  const profile = RISK_PROFILES[risk];

  return (
    <div className="space-y-2" data-testid="breakout-top-drivers">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium">Top drivers</p>
        <Badge variant="outline" className="text-[10px] font-normal">
          score = P&amp;L share + {view.gapWeight}× expectancy gap
        </Badge>
      </div>

      <div className="grid gap-3 rounded-md border border-border/40 p-2 sm:grid-cols-2">
        <div>
          <p className="text-[11px] font-medium text-muted-foreground">Risk setting</p>
          <ToggleGroup
            type="single"
            size="sm"
            value={risk}
            onValueChange={(v) => v && setRisk(v as RiskLevel)}
            className="mt-1 justify-start"
            data-testid="driver-risk-toggle"
          >
            {RISK_LEVELS.map((l) => (
              <ToggleGroupItem key={l} value={l} className="text-[11px] capitalize">
                {l}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <p className="mt-1 text-[11px] text-muted-foreground">
            priority ≥ {profile.prioritiseAt} · avoid ≤ {profile.avoidAt} · needs{" "}
            {(profile.minConfidence * 100).toFixed(0)} confidence for full size
          </p>
        </div>
        <div>
          <div className="flex items-baseline justify-between">
            <p className="text-[11px] font-medium text-muted-foreground">Expectancy-gap weight</p>
            <span className="text-[11px] tabular-nums" data-testid="gap-weight-value">
              {gapWeight.toFixed(1)}×
            </span>
          </div>
          <Slider
            className="mt-2"
            min={0}
            max={weights.length - 1}
            step={1}
            value={[Math.min(weightIdx, weights.length - 1)]}
            onValueChange={([v]) => setGapWeight(v ?? 0)}
            aria-label="Expectancy-gap weight"
            data-testid="gap-weight-slider"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            {symbols?.length
              ? "0 ranks purely on P&L share; higher values favour names where the signal itself adds edge."
              : "Per-symbol detail unavailable — showing the server ranking."}
          </p>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground" data-testid="driver-action-summary">
        {summariseActions(recs, risk)}
      </p>

      {cell ? <ExecutionImpact cell={cell} grid={execution!} /> : null}
      <p className="text-[11px] text-muted-foreground">{view.summary}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Side
          title="Biggest positive"
          rows={view.positive}
          empty="No net-positive contributors."
          risk={risk}
        />
        <Side
          title="Biggest negative"
          rows={view.negative}
          empty="No net-negative contributors."
          risk={risk}
        />
      </div>
    </div>
  );
}
