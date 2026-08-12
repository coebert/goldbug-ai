import { ChartFrame } from "@/components/chart-frame";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  listBacktestRuns,
  deleteBacktestRun as deleteBacktestRunFn,
  clearBacktestRuns as clearBacktestRunsFn,
  type PersistedBacktestRun,
} from "@/lib/backtest-runs.functions";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { BacktestMetrics } from "@/lib/backtest-metrics";
import {
  AXIS_LINE,
  AXIS_TICK,
  CHART_ROLE,
  GRID_PROPS,
  LEGEND_PROPS,
  OKABE_ITO,
  TICK_LINE,
  TOOLTIP_CONTENT_STYLE,
} from "@/lib/chart-palette";

export type BacktestEquityPoint = { snapshot_date: string; total_value: number };

export type BacktestRunRecord = {
  id: string;
  ranAt: string; // ISO
  portfolioId: string;
  riskLevel: string;
  days: number;
  metrics: BacktestMetrics;
  // Optional per-run equity series captured at save-time. Overlays in the
  // history card need this because there is no per-run entity server-side
  // to re-fetch from — each backtest recomputes over shared snapshots.
  equity?: BacktestEquityPoint[];
};

// Deterministic overlay colours so a given run keeps its colour across
// re-renders and toggles.
const OVERLAY_PALETTE = [
  OKABE_ITO.skyBlue,
  CHART_ROLE.positive,
  CHART_ROLE.benchmark,
  OKABE_ITO.reddishPurple,
  CHART_ROLE.negative,
  "hsl(199 89% 48%)",
  "hsl(48 96% 53%)",
  "hsl(262 83% 58%)",
];

// React Query key for a portfolio's persisted run history.
export const backtestRunsQueryKey = (portfolioId: string) => ["backtestRuns", portfolioId] as const;

// `saveRun` was moved to `@/lib/backtest-run-save` so imperative callers
// can persist a run without importing this heavy card module. Re-exported
// here for backwards compatibility with any lingering callers.
export { saveRun } from "@/lib/backtest-run-save";

function fmt(n: number | null | undefined, digits = 2, suffix = "") {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)}${suffix}`;
}

function toneClass(v: number | null | undefined, invert = false) {
  if (v == null || !Number.isFinite(v)) return "text-muted-foreground";
  const good = invert ? v <= 0 : v >= 0;
  return good ? "text-emerald-500" : "text-red-500";
}

function ReasonRow({
  label,
  raw,
  norm,
  weight,
  contribution,
  tone,
  hint,
}: {
  label: string;
  raw: string;
  norm: number;
  weight: number;
  contribution: number;
  tone: string;
  hint?: string;
}) {
  const pct = Math.max(0, Math.min(1, norm)) * 100;
  return (
    <div className="rounded border border-border/50 bg-background/60 px-2 py-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className={`text-sm font-medium ${tone}`}>{raw}</span>
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded bg-border/50">
        <div className="h-full bg-primary/70" style={{ width: `${pct.toFixed(1)}%` }} aria-hidden />
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>
          norm {norm.toFixed(2)} × w {(weight * 100).toFixed(0)}%
        </span>
        <span className="font-mono">+{contribution.toFixed(3)}</span>
      </div>
      {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

type RiskTolerance = "conservative" | "balanced" | "aggressive";

// Weights sum to 1. MDD is treated as "lower is better" — inverted before
// weighting. Conservative punishes drawdowns hardest; aggressive rewards
// return most. Sharpe is always meaningful so it never drops below 0.2.
const TOLERANCE_WEIGHTS: Record<RiskTolerance, { ret: number; mdd: number; sharpe: number }> = {
  conservative: { ret: 0.2, mdd: 0.55, sharpe: 0.25 },
  balanced: { ret: 0.35, mdd: 0.35, sharpe: 0.3 },
  aggressive: { ret: 0.6, mdd: 0.1, sharpe: 0.3 },
};

function inferTolerance(riskLevel: string | undefined): RiskTolerance {
  const s = (riskLevel ?? "").toLowerCase();
  if (s.includes("low") || s.includes("conserv")) return "conservative";
  if (s.includes("high") || s.includes("aggress")) return "aggressive";
  return "balanced";
}

// Min-max normalize into [0,1]. When all values are equal, everyone scores 1
// (nothing differentiates them on this axis, so it shouldn't drag anyone down).
function normalize(values: number[]): number[] {
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length) return values.map(() => 0);
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  if (hi === lo) return values.map((v) => (Number.isFinite(v) ? 1 : 0));
  return values.map((v) => (Number.isFinite(v) ? (v - lo) / (hi - lo) : 0));
}

export function BacktestRunHistoryCard({
  portfolioId,
  portfolioRiskLevel,
}: {
  portfolioId: string;
  portfolioRiskLevel?: string;
}) {
  const qc = useQueryClient();
  const listFn = useServerFn(listBacktestRuns);
  const deleteFn = useServerFn(deleteBacktestRunFn);
  const clearFn = useServerFn(clearBacktestRunsFn);

  const runsQuery = useQuery({
    queryKey: backtestRunsQueryKey(portfolioId),
    queryFn: () => listFn({ data: { portfolioId } }),
    staleTime: 30_000,
  });

  // Map the persisted row shape into the card's in-memory record shape.
  // metrics/equity are stored as opaque JSON server-side to avoid coupling
  // the schema to the metrics engine; we cast on read.
  const runs: BacktestRunRecord[] = useMemo(() => {
    const rows = runsQuery.data ?? [];
    return rows.map((r: PersistedBacktestRun) => ({
      id: r.id,
      ranAt: r.ran_at,
      portfolioId: r.portfolio_id,
      riskLevel: r.risk_level ?? "unknown",
      days: r.days,
      metrics: r.metrics as unknown as BacktestMetrics,
      equity: (r.equity as unknown as BacktestEquityPoint[] | null) ?? undefined,
    }));
  }, [runsQuery.data]);

  // Refresh when a save/delete elsewhere fires the event bus.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const refresh = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (!detail || detail === portfolioId) {
        qc.invalidateQueries({ queryKey: backtestRunsQueryKey(portfolioId) });
      }
    };
    window.addEventListener("aegis:backtest-runs-updated", refresh);
    return () => window.removeEventListener("aegis:backtest-runs-updated", refresh);
  }, [portfolioId, qc]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupByRisk, setGroupByRisk] = useState(true);
  const [tolerance, setTolerance] = useState<RiskTolerance>(() =>
    inferTolerance(portfolioRiskLevel),
  );

  const clearAll = async () => {
    await clearFn({ data: { portfolioId } });
    setSelected(new Set());
    qc.invalidateQueries({ queryKey: backtestRunsQueryKey(portfolioId) });
  };

  const removeOne = async (id: string) => {
    await deleteFn({ data: { id } });
    setSelected((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    qc.invalidateQueries({ queryKey: backtestRunsQueryKey(portfolioId) });
  };

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // Group by risk for the side-by-side comparison
  const compareRuns = selected.size > 0 ? runs.filter((r) => selected.has(r.id)) : runs;
  const grouped = new Map<string, BacktestRunRecord[]>();
  for (const r of compareRuns) {
    const key = groupByRisk ? r.riskLevel || "unknown" : r.id;
    const list = grouped.get(key) ?? [];
    list.push(r);
    grouped.set(key, list);
  }
  // Aggregate per group (avg + best/worst latest)
  const aggregates = Array.from(grouped.entries()).map(([key, list]) => {
    const avg = (fn: (r: BacktestRunRecord) => number | null | undefined) => {
      const vals = list.map(fn).filter((v): v is number => v != null && Number.isFinite(v));
      if (!vals.length) return null;
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    };
    return {
      key,
      count: list.length,
      latest: list[0],
      avgReturn: avg((r) => r.metrics.totalReturnPct),
      avgMDD: avg((r) => r.metrics.maxDrawdownPct),
      avgSharpe: avg((r) => r.metrics.sharpe),
      avgWin: avg((r) => r.metrics.winRatePct ?? null),
    };
  });

  // Overlay data for the equity + drawdown charts.
  // Runs are aligned by day-index (t = 0..N) because they may span different
  // absolute date ranges; comparing them at the same *elapsed day* is the
  // apples-to-apples view. Equity is normalized to % change vs the run's own
  // starting equity; drawdown is (v / running-peak - 1) * 100.
  const overlayRuns = useMemo(
    () =>
      compareRuns.filter(
        (r): r is BacktestRunRecord & { equity: BacktestEquityPoint[] } =>
          Array.isArray(r.equity) && r.equity.length >= 2,
      ),
    [compareRuns],
  );

  const overlaySeries = useMemo(() => {
    return overlayRuns.map((r, idx) => {
      const start = r.equity[0].total_value;
      const safeStart = start !== 0 && Number.isFinite(start) ? start : 1;
      let peak = start;
      const points = r.equity.map((p, i) => {
        peak = Math.max(peak, p.total_value);
        const equityPct = ((p.total_value - safeStart) / Math.abs(safeStart)) * 100;
        const ddPct = peak > 0 ? (p.total_value / peak - 1) * 100 : 0;
        return { t: i, date: p.snapshot_date, equity: equityPct, drawdown: ddPct };
      });
      const label = `${new Date(r.ranAt).toLocaleDateString("en-GB", { timeZone: "Europe/London" })} · ${r.riskLevel} · ${r.days}d`;
      return {
        id: r.id,
        label,
        color: OVERLAY_PALETTE[idx % OVERLAY_PALETTE.length],
        points,
      };
    });
  }, [overlayRuns]);

  // Recharts wants a single dataset when overlaying series that share an
  // x-axis; key each run's series by its id so multiple lines coexist.
  const mergedOverlay = useMemo(() => {
    const maxLen = overlaySeries.reduce((m, s) => Math.max(m, s.points.length), 0);
    const rows: Array<Record<string, number | string>> = [];
    for (let t = 0; t < maxLen; t++) {
      const row: Record<string, number | string> = { t };
      for (const s of overlaySeries) {
        const p = s.points[t];
        if (p) {
          row[`eq_${s.id}`] = p.equity;
          row[`dd_${s.id}`] = p.drawdown;
        }
      }
      rows.push(row);
    }
    return rows;
  }, [overlaySeries]);

  // Recommendation: rank runs matching the chosen risk tolerance's own risk
  // level bucket first, then fall back to the full pool if none match. Each
  // axis is min-max normalized across the candidate pool so weights compose
  // sensibly. MDD is stored as a negative pct (or 0), so we invert its
  // magnitude — smaller drawdowns score higher.
  const recommendation = useMemo(() => {
    if (runs.length === 0) return null;
    const targetBucket = tolerance; // conservative | balanced | aggressive
    const bucketMatches = runs.filter((r) => inferTolerance(r.riskLevel) === targetBucket);
    const pool = bucketMatches.length > 0 ? bucketMatches : runs;
    const scopedToBucket = bucketMatches.length > 0;

    // Annualise totalReturnPct so runs of different horizons are comparable.
    // Prior behaviour compared a 400-day 15% run against a 30-day 3% run on
    // the same axis and systematically favoured the longer horizon.
    const rets = pool.map((r) => {
      const total = r.metrics.totalReturnPct ?? 0;
      const days = Math.max(1, r.days ?? 0);
      const years = days / 365.25;
      if (years <= 0) return total;
      const base = 1 + total / 100;
      if (base <= 0) return total; // full loss – leave as-is
      return (Math.pow(base, 1 / years) - 1) * 100;
    });
    const mddMag = pool.map((r) => Math.abs(r.metrics.maxDrawdownPct ?? 0));
    const sharpes = pool.map((r) => r.metrics.sharpe ?? 0);

    const nRet = normalize(rets);
    // Invert MDD magnitude so lower drawdown => higher score.
    const nMddRaw = normalize(mddMag);
    const nMdd = nMddRaw.map((v) => 1 - v);
    const nSharpe = normalize(sharpes);

    const w = TOLERANCE_WEIGHTS[tolerance];
    const scored = pool.map((r, i) => ({
      run: r,
      score: nRet[i] * w.ret + nMdd[i] * w.mdd + nSharpe[i] * w.sharpe,
      parts: {
        ret: { raw: rets[i], norm: nRet[i], contribution: nRet[i] * w.ret },
        mdd: { raw: -mddMag[i], norm: nMdd[i], contribution: nMdd[i] * w.mdd },
        sharpe: { raw: sharpes[i], norm: nSharpe[i], contribution: nSharpe[i] * w.sharpe },
      },
    }));
    scored.sort((a, b) => b.score - a.score);
    return {
      best: scored[0],
      runnerUp: scored[1] ?? null,
      weights: w,
      poolSize: pool.length,
      scopedToBucket,
    };
  }, [runs, tolerance]);

  return (
    <Card className="mb-4">
      <CardHeader className="pb-2 flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="text-sm">Backtest run history</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Compare metrics across risk levels. Runs are stored locally in this browser.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={groupByRisk ? "default" : "outline"}
            onClick={() => setGroupByRisk((g) => !g)}
          >
            {groupByRisk ? "Grouped by risk" : "Per run"}
          </Button>
          {runs.length > 0 && (
            <Button size="sm" variant="ghost" onClick={clearAll}>
              Clear
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No runs recorded yet. Run a backtest and its metrics will appear here.
          </p>
        ) : (
          <>
            {/* Recommendation panel */}
            <div className="mb-4 rounded-md border border-border/60 bg-muted/30 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Recommended run for your risk tolerance
                </div>
                <div className="flex items-center gap-1" role="tablist" aria-label="Risk tolerance">
                  {(["conservative", "balanced", "aggressive"] as const).map((t) => (
                    <Button
                      key={t}
                      size="sm"
                      variant={tolerance === t ? "default" : "outline"}
                      onClick={() => setTolerance(t)}
                      className="h-7 px-2 text-xs capitalize"
                    >
                      {t}
                    </Button>
                  ))}
                </div>
              </div>
              {recommendation ? (
                <div className="mt-3">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <div className="text-sm font-semibold">
                      {new Date(recommendation.best.run.ranAt).toLocaleString("en-GB", {
                        timeZone: "Europe/London",
                      })}
                    </div>
                    <Badge variant="secondary" className="capitalize">
                      {recommendation.best.run.riskLevel || "unknown"} risk
                    </Badge>
                    <div className="text-xs text-muted-foreground">
                      {recommendation.best.run.days}d window · score{" "}
                      <span className="font-mono text-foreground">
                        {recommendation.best.score.toFixed(3)}
                      </span>
                      {recommendation.runnerUp && (
                        <>
                          {" "}
                          · next best{" "}
                          <span className="font-mono text-foreground">
                            {recommendation.runnerUp.score.toFixed(3)}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
                    <ReasonRow
                      label="Return"
                      raw={fmt(recommendation.best.parts.ret.raw, 2, "%")}
                      norm={recommendation.best.parts.ret.norm}
                      weight={recommendation.weights.ret}
                      contribution={recommendation.best.parts.ret.contribution}
                      tone={toneClass(recommendation.best.parts.ret.raw)}
                    />
                    <ReasonRow
                      label="Max drawdown"
                      raw={fmt(recommendation.best.parts.mdd.raw, 2, "%")}
                      norm={recommendation.best.parts.mdd.norm}
                      weight={recommendation.weights.mdd}
                      contribution={recommendation.best.parts.mdd.contribution}
                      tone={toneClass(recommendation.best.parts.mdd.raw, true)}
                      hint="lower is better"
                    />
                    <ReasonRow
                      label="Sharpe"
                      raw={fmt(recommendation.best.parts.sharpe.raw, 2)}
                      norm={recommendation.best.parts.sharpe.norm}
                      weight={recommendation.weights.sharpe}
                      contribution={recommendation.best.parts.sharpe.contribution}
                      tone={toneClass(recommendation.best.parts.sharpe.raw)}
                    />
                  </div>

                  <p className="mt-2 text-xs text-muted-foreground">
                    Ranked against{" "}
                    {recommendation.scopedToBucket
                      ? `${recommendation.poolSize} run(s) at ${tolerance} risk level`
                      : `all ${recommendation.poolSize} runs (no ${tolerance}-level runs recorded yet)`}
                    . Each axis is normalized 0–1 across the pool, then weighted{" "}
                    <span className="font-mono">
                      ret {(recommendation.weights.ret * 100).toFixed(0)}% · mdd{" "}
                      {(recommendation.weights.mdd * 100).toFixed(0)}% · sharpe{" "}
                      {(recommendation.weights.sharpe * 100).toFixed(0)}%
                    </span>
                    . Drawdown is inverted so smaller losses score higher.
                  </p>
                </div>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">
                  Run a backtest to see a recommendation.
                </p>
              )}
            </div>

            {groupByRisk && aggregates.length > 0 && (
              <div className="mb-4 overflow-x-auto">
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Side-by-side by risk level
                  {selected.size > 0
                    ? ` (${selected.size} selected)`
                    : ` (all ${runs.length} runs)`}
                </div>
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                      <th className="py-2 pr-3">Risk level</th>
                      <th className="py-2 pr-3">Runs</th>
                      <th className="py-2 pr-3">Avg return</th>
                      <th className="py-2 pr-3">Avg MDD</th>
                      <th className="py-2 pr-3">Avg Sharpe</th>
                      <th className="py-2 pr-3">Avg win rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {aggregates
                      .sort((a, b) => a.key.localeCompare(b.key))
                      .map((g) => (
                        <tr key={g.key} className="border-b border-border/50">
                          <td className="py-2 pr-3">
                            <Badge variant="secondary" className="uppercase">
                              {g.key}
                            </Badge>
                          </td>
                          <td className="py-2 pr-3 text-muted-foreground">{g.count}</td>
                          <td className={`py-2 pr-3 tabular-nums ${toneClass(g.avgReturn)}`}>
                            {fmt(g.avgReturn, 2, "%")}
                          </td>
                          <td className={`py-2 pr-3 tabular-nums ${toneClass(g.avgMDD, true)}`}>
                            {fmt(g.avgMDD, 2, "%")}
                          </td>
                          <td className={`py-2 pr-3 tabular-nums ${toneClass(g.avgSharpe)}`}>
                            {fmt(g.avgSharpe, 2)}
                          </td>
                          <td className="py-2 pr-3 tabular-nums">{fmt(g.avgWin, 0, "%")}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}

            {overlaySeries.length > 0 && (
              <div className="mb-6">
                <div className="mb-2 flex items-baseline justify-between gap-2">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Overlay ({overlaySeries.length} run{overlaySeries.length === 1 ? "" : "s"})
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    Aligned by elapsed day; equity shown as % vs each run's start.
                  </div>
                </div>
                <div className="mb-1 text-xs text-muted-foreground">Equity curve</div>
                <ChartFrame className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={mergedOverlay}
                      margin={{ top: 8, right: 16, bottom: 4, left: 4 }}
                    >
                      <CartesianGrid {...GRID_PROPS} />
                      <XAxis
                        dataKey="t"
                        tick={AXIS_TICK}
                        label={{
                          value: "Day",
                          position: "insideBottom",
                          offset: -2,
                          fontSize: 12,
                          fill: "var(--foreground)",
                        }}
                        axisLine={AXIS_LINE}
                        tickLine={TICK_LINE}
                      />
                      <YAxis
                        tick={AXIS_TICK}
                        tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                        width={64}
                        axisLine={AXIS_LINE}
                        tickLine={TICK_LINE}
                      />
                      <Tooltip
                        formatter={(v: number, name: string) => [`${v.toFixed(2)}%`, name]}
                        labelFormatter={(t: number) => `Day ${t}`}
                        contentStyle={TOOLTIP_CONTENT_STYLE}
                      />
                      <Legend {...LEGEND_PROPS} />
                      {overlaySeries.map((s) => (
                        <Line
                          key={s.id}
                          type="monotone"
                          dataKey={`eq_${s.id}`}
                          name={s.label}
                          stroke={s.color}
                          strokeWidth={2}
                          dot={false}
                          isAnimationActive={false}
                          connectNulls
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </ChartFrame>
                <div className="mb-1 mt-4 text-xs text-muted-foreground">Drawdown curve</div>
                <ChartFrame className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={mergedOverlay}
                      margin={{ top: 8, right: 16, bottom: 4, left: 4 }}
                    >
                      <CartesianGrid {...GRID_PROPS} />
                      <XAxis
                        dataKey="t"
                        tick={AXIS_TICK}
                        label={{
                          value: "Day",
                          position: "insideBottom",
                          offset: -2,
                          fontSize: 12,
                          fill: "var(--foreground)",
                        }}
                        axisLine={AXIS_LINE}
                        tickLine={TICK_LINE}
                      />
                      <YAxis
                        tick={AXIS_TICK}
                        tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                        width={64}
                        domain={["auto", 0]}
                        axisLine={AXIS_LINE}
                        tickLine={TICK_LINE}
                      />
                      <Tooltip
                        formatter={(v: number, name: string) => [`${v.toFixed(2)}%`, name]}
                        labelFormatter={(t: number) => `Day ${t}`}
                        contentStyle={TOOLTIP_CONTENT_STYLE}
                      />
                      <Legend {...LEGEND_PROPS} />
                      {overlaySeries.map((s) => (
                        <Line
                          key={s.id}
                          type="monotone"
                          dataKey={`dd_${s.id}`}
                          name={s.label}
                          stroke={s.color}
                          strokeWidth={2}
                          dot={false}
                          isAnimationActive={false}
                          connectNulls
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </ChartFrame>
              </div>
            )}

            {compareRuns.length > 0 && overlaySeries.length === 0 && (
              <div className="mb-4 rounded-md border border-dashed border-border/60 p-3 text-xs text-muted-foreground">
                No equity series stored for the selected runs. Newer runs record their equity curve
                automatically; re-run a backtest to populate the overlay charts.
              </div>
            )}

            <div className="overflow-x-auto">
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                All runs (select rows to narrow the comparison above)
              </div>
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                    <th className="py-2 pr-2 w-8"></th>
                    <th className="py-2 pr-3">When</th>
                    <th className="py-2 pr-3">Risk</th>
                    <th className="py-2 pr-3">Days</th>
                    <th className="py-2 pr-3">Return</th>
                    <th className="py-2 pr-3">MDD</th>
                    <th className="py-2 pr-3">Sharpe</th>
                    <th className="py-2 pr-3">Win rate</th>
                    <th className="py-2 pr-3">Trades</th>
                    <th className="py-2 pr-2 w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => {
                    const m = r.metrics;
                    return (
                      <tr key={r.id} className="border-b border-border/50">
                        <td className="py-2 pr-2">
                          <input
                            type="checkbox"
                            aria-label="Select run for comparison"
                            checked={selected.has(r.id)}
                            onChange={() => toggle(r.id)}
                          />
                        </td>
                        <td className="py-2 pr-3 text-muted-foreground whitespace-nowrap">
                          {new Date(r.ranAt).toLocaleString("en-GB", { timeZone: "Europe/London" })}
                        </td>
                        <td className="py-2 pr-3">
                          <Badge variant="secondary" className="uppercase">
                            {r.riskLevel}
                          </Badge>
                        </td>
                        <td className="py-2 pr-3 tabular-nums">{r.days}</td>
                        <td className={`py-2 pr-3 tabular-nums ${toneClass(m.totalReturnPct)}`}>
                          {fmt(m.totalReturnPct, 2, "%")}
                        </td>
                        <td
                          className={`py-2 pr-3 tabular-nums ${toneClass(m.maxDrawdownPct, true)}`}
                        >
                          {fmt(m.maxDrawdownPct, 2, "%")}
                        </td>
                        <td className={`py-2 pr-3 tabular-nums ${toneClass(m.sharpe)}`}>
                          {fmt(m.sharpe, 2)}
                        </td>
                        <td className="py-2 pr-3 tabular-nums">
                          {fmt(m.winRatePct ?? null, 0, "%")}
                        </td>
                        <td className="py-2 pr-3 tabular-nums text-muted-foreground">
                          {m.wins}W / {m.losses}L / {m.trades}
                        </td>
                        <td className="py-2 pr-2">
                          <Button size="sm" variant="ghost" onClick={() => removeOne(r.id)}>
                            ×
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
