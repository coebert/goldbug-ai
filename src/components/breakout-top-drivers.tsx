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
import {
  compareDriverSettings,
  type DriverSetting,
} from "@/lib/breakout-driver-compare";
import { Button } from "@/components/ui/button";
import {
  ACTIONS,
  ACTION_STANCE,
  CONFIDENCE_LABELS,
  STANCES,
  actionMix,
  diffActionMix,
  type ActionMix,
} from "@/lib/breakout-action-mix";

const STANCE_LABEL: Record<(typeof STANCES)[number], string> = {
  buy: "Buy",
  hold: "Partial / hold",
  sell: "Stand aside",
};

const STANCE_BAR: Record<(typeof STANCES)[number], string> = {
  buy: "bg-emerald-500",
  hold: "bg-amber-500",
  sell: "bg-red-500",
};

const CONF_BAR: Record<(typeof CONFIDENCE_LABELS)[number], string> = {
  high: "bg-sky-500",
  medium: "bg-sky-500/60",
  low: "bg-sky-500/30",
};

const delta = (n: number, digits = 0) =>
  n === 0 ? "±0" : `${n > 0 ? "+" : ""}${n.toFixed(digits)}`;

function MixBar({
  label,
  count,
  pct,
  colour,
  deltaCount,
  testId,
}: {
  label: string;
  count: number;
  pct: number;
  colour: string;
  deltaCount?: number;
  testId: string;
}) {
  return (
    <div data-testid={testId}>
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span>{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {count} · {pct.toFixed(0)}%
          {deltaCount != null && deltaCount !== 0 ? (
            <span className={`ml-1 ${deltaCount > 0 ? "text-emerald-500" : "text-red-500"}`}>
              {delta(deltaCount)}
            </span>
          ) : null}
        </span>
      </div>
      <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={`h-full ${colour}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  );
}

/** Recommended-action mix at the current setting, with shift vs the previous one. */
function ActionMixPanel({ mix, prevMix }: { mix: ActionMix; prevMix: ActionMix | null }) {
  const diff = prevMix ? diffActionMix(prevMix, mix) : null;
  return (
    <div className="rounded-md border border-border/40 p-2" data-testid="driver-action-mix">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-medium">Recommended action mix</p>
        <Badge variant="outline" className="text-[10px] font-normal tabular-nums">
          avg size {mix.avgSize.toFixed(2)}×
          {diff && diff.avgSizeDelta !== 0 ? ` (${delta(diff.avgSizeDelta, 2)}×)` : ""}
        </Badge>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground" data-testid="action-mix-summary">
        {mix.summary}
      </p>
      <div className="mt-2 grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Stance</p>
          {STANCES.map((s) => (
            <MixBar
              key={s}
              testId={`mix-stance-${s}`}
              label={STANCE_LABEL[s]}
              count={mix.byStance[s].count}
              pct={mix.byStance[s].pct}
              colour={STANCE_BAR[s]}
              deltaCount={diff?.byStance[s].count}
            />
          ))}
        </div>
        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Action</p>
          {ACTIONS.map((a) => (
            <MixBar
              key={a}
              testId={`mix-action-${a}`}
              label={a[0].toUpperCase() + a.slice(1)}
              count={mix.byAction[a].count}
              pct={mix.byAction[a].pct}
              colour={STANCE_BAR[ACTION_STANCE[a]]}
              deltaCount={diff?.byAction[a].count}
            />
          ))}
        </div>
        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Confidence</p>
          {CONFIDENCE_LABELS.map((c) => (
            <MixBar
              key={c}
              testId={`mix-confidence-${c}`}
              label={c[0].toUpperCase() + c.slice(1)}
              count={mix.byConfidence[c].count}
              pct={mix.byConfidence[c].pct}
              colour={CONF_BAR[c]}
              deltaCount={diff?.byConfidence[c].count}
            />
          ))}
        </div>
      </div>
      {diff ? (
        <p className="mt-2 text-[11px] text-muted-foreground" data-testid="action-mix-shift">
          Shift from {diff.from.setting.risk} · {diff.from.setting.gapWeight.toFixed(1)}×:{" "}
          {diff.summary}
        </p>
      ) : null}
    </div>
  );
}



const STATUS_LABEL: Record<string, string> = {
  entered: "new",
  left: "dropped",
  changed: "changed",
  same: "same",
};

function WhatIfCompare({
  symbols,
  a,
  b,
}: {
  symbols: readonly SymbolDiagnostic[];
  a: DriverSetting;
  b: DriverSetting;
}) {
  const cmp = useMemo(() => compareDriverSettings(symbols, a, b), [symbols, a, b]);
  const head = (s: DriverSetting) => `${s.risk} · ${s.gapWeight.toFixed(1)}×`;

  return (
    <div className="rounded-md border border-border/40 p-2" data-testid="driver-what-if">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-medium">What-if: previous vs current</p>
        <Badge variant="outline" className="text-[10px] font-normal">
          {cmp.changedCount} changed
        </Badge>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground" data-testid="what-if-summary">
        {cmp.summary}
      </p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 text-left font-normal">Symbol</th>
              <th className="py-1 text-left font-normal">Previous · {head(a)}</th>
              <th className="py-1 text-left font-normal">Current · {head(b)}</th>
              <th className="py-1 text-right font-normal">Δ rank</th>
              <th className="py-1 text-right font-normal">Δ size</th>
            </tr>
          </thead>
          <tbody>
            {cmp.rows.map((r) => (
              <tr
                key={r.symbol}
                className="border-t border-border/30"
                data-testid={`what-if-row-${r.symbol}`}
              >
                <td className="py-1 font-medium">
                  {r.symbol}
                  {r.status !== "same" ? (
                    <span className="ml-1 text-[10px] text-muted-foreground">
                      {STATUS_LABEL[r.status]}
                    </span>
                  ) : null}
                </td>
                <td className="py-1">
                  {r.a.action ? (
                    <span className={ACTION_TONE[r.a.action]}>
                      {r.a.action} · {r.a.sizeMultiplier?.toFixed(2)}×
                    </span>
                  ) : (
                    <span className="text-muted-foreground">unranked</span>
                  )}
                </td>
                <td className="py-1">
                  {r.b.action ? (
                    <span className={ACTION_TONE[r.b.action]}>
                      {r.b.action} · {r.b.sizeMultiplier?.toFixed(2)}×
                    </span>
                  ) : (
                    <span className="text-muted-foreground">unranked</span>
                  )}
                </td>
                <td className="py-1 text-right tabular-nums">
                  {r.rankDelta == null
                    ? "—"
                    : `${r.rankDelta > 0 ? "+" : ""}${r.rankDelta}`}
                </td>
                <td
                  className={`py-1 text-right tabular-nums ${r.sizeDelta ? tone(r.sizeDelta) : ""}`}
                >
                  {r.sizeDelta == null ? "—" : `${r.sizeDelta > 0 ? "+" : ""}${r.sizeDelta.toFixed(2)}×`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}


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
  const [risk, setRisk] = useState<RiskLevel>("balanced");
  // Remember the setting the user was on before the latest change so the
  // what-if view can diff "previous vs current".
  const [prev, setPrev] = useState<DriverSetting>({ risk: "balanced", gapWeight });
  const [showCompare, setShowCompare] = useState(false);
  const setGapWeight = (i: number) => {
    const next = weights[Math.min(i, weights.length - 1)] ?? gapWeight;
    if (next === gapWeight) return;
    setPrev({ risk, gapWeight });
    setWeightIdx(i);
  };
  const changeRisk = (l: RiskLevel) => {
    if (l === risk) return;
    setPrev({ risk, gapWeight });
    setRisk(l);
  };


  const view = useMemo(() => {
    if (!symbols?.length || gapWeight === drivers.gapWeight) return drivers;
    return rankDrivers(symbols, { gapWeight });
  }, [symbols, gapWeight, drivers]);

  const recs = useMemo(
    () => recommendDriverActions([...view.positive, ...view.negative], risk),
    [view, risk],
  );

  const mix = useMemo(
    () => actionMix([...view.positive, ...view.negative], { risk, gapWeight }),
    [view, risk, gapWeight],
  );

  const prevMix = useMemo(() => {
    if (!symbols?.length) return null;
    if (prev.risk === risk && prev.gapWeight === gapWeight) return null;
    return actionMixFor(symbols, prev);
  }, [symbols, prev, risk, gapWeight]);

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
            onValueChange={(v) => v && changeRisk(v as RiskLevel)}
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

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground" data-testid="driver-action-summary">
          {summariseActions(recs, risk)}
        </p>
        {symbols?.length ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[11px]"
            onClick={() => setShowCompare((s) => !s)}
            data-testid="what-if-toggle"
          >
            {showCompare ? "Hide what-if" : "Compare with previous"}
          </Button>
        ) : null}
      </div>

      {showCompare && symbols?.length ? (
        <WhatIfCompare symbols={symbols} a={prev} b={{ risk, gapWeight }} />
      ) : null}

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
