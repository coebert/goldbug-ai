import { useMemo } from "react";
import { armHeadlineMetrics } from "@/lib/backtest/arm-metrics";
import type { ArmResult } from "@/lib/backtest/insider-nudge-replay";

type Arm = { result: ArmResult; label: string; color: string };

function fmtPct(v: number | null, digits = 2) {
  if (v == null || !Number.isFinite(v)) return "—";
  const s = v.toFixed(digits);
  return `${v > 0 ? "+" : ""}${s}%`;
}

/** Compact day count: sub-day holds read as hours, long ones as months. */
function fmtDays(v: number) {
  if (!Number.isFinite(v)) return "—";
  if (v < 1) return `${Math.round(v * 24)}h`;
  if (v < 60) return `${v.toFixed(v < 10 ? 1 : 0)}d`;
  return `${(v / 30.44).toFixed(1)}mo`;
}

type MetricRow = {
  key: string;
  label: string;
  hint: string;
  value: (i: number) => string;
  score: (i: number) => number | null;
  /** null = neither direction is "better", so no row highlight. */
  higherIsBetter: boolean | null;
};


/**
 * Per-arm headline metrics. Best value in each row is highlighted so the
 * comparison reads at a glance on a phone as well as a wide screen.
 */
export function ArmMetricsPanel({ arms, className }: { arms: Arm[]; className?: string }) {
  const metrics = useMemo(() => arms.map((a) => ({ ...a, m: armHeadlineMetrics(a.result) })), [arms]);
  if (!metrics.length) return null;

  const rows = [
    {
      key: "cagr",
      label: "CAGR",
      hint: "Annualised growth rate of the arm's equity.",
      value: (i: number) => fmtPct(metrics[i]!.m.cagrPct),
      score: (i: number) => metrics[i]!.m.cagrPct,
      higherIsBetter: true,
    },
    {
      key: "total",
      label: "Total return",
      hint: "End equity versus start, over the whole tape.",
      value: (i: number) => fmtPct(metrics[i]!.m.totalReturnPct),
      score: (i: number) => metrics[i]!.m.totalReturnPct,
      higherIsBetter: true,
    },
    {
      key: "vol",
      label: "Volatility (ann.)",
      hint: "Annualised standard deviation of daily returns.",
      value: (i: number) => `${metrics[i]!.m.volAnnPct.toFixed(2)}%`,
      score: (i: number) => metrics[i]!.m.volAnnPct,
      higherIsBetter: false,
    },
    {
      key: "dd",
      label: "Max drawdown",
      hint: "Deepest peak-to-trough fall in equity.",
      value: (i: number) => `${metrics[i]!.m.maxDrawdownPct.toFixed(2)}%`,
      score: (i: number) => metrics[i]!.m.maxDrawdownPct,
      higherIsBetter: false,
    },
    {
      key: "win",
      label: "Win rate",
      hint: "Share of closed positions that made money.",
      value: (i: number) => {
        const m = metrics[i]!.m;
        if (m.winRatePct == null) return "—";
        const suffix = m.winRateFromDays ? " of days" : ` of ${m.wins + m.losses}`;
        return `${m.winRatePct.toFixed(0)}%${suffix}`;
      },
      score: (i: number) => metrics[i]!.m.winRatePct,
      higherIsBetter: true,
    },
    {
      key: "pf",
      label: "Profit factor",
      hint: "Gross profit divided by gross loss on closed positions. Above 1 means winners outweigh losers.",
      value: (i: number) => {
        const v = metrics[i]!.m.profitFactor;
        return v == null || !Number.isFinite(v) ? "—" : v.toFixed(2);
      },
      score: (i: number) => metrics[i]!.m.profitFactor,
      higherIsBetter: true,
    },
    {
      key: "expectancy",
      label: "Expectancy / trade",
      hint: "Average equity contribution per closed position.",
      value: (i: number) => fmtPct(metrics[i]!.m.expectancyPct),
      score: (i: number) => metrics[i]!.m.expectancyPct,
      higherIsBetter: true,
    },
    {
      key: "hold",
      label: "Avg holding time",
      hint: "Mean calendar days held per closed position, with the median in brackets.",
      value: (i: number) => {
        const m = metrics[i]!.m;
        if (m.avgHoldDays == null) return "—";
        const med = m.medianHoldDays == null ? "" : ` (med ${fmtDays(m.medianHoldDays)})`;
        return `${fmtDays(m.avgHoldDays)}${med}`;
      },
      score: (i: number) => metrics[i]!.m.avgHoldDays,
      higherIsBetter: null,
    },
    {
      key: "maxhold",
      label: "Longest hold",
      hint: "Calendar days of the single longest closed position.",
      value: (i: number) => {
        const v = metrics[i]!.m.maxHoldDays;
        return v == null ? "—" : fmtDays(v);
      },
      score: (i: number) => metrics[i]!.m.maxHoldDays,
      higherIsBetter: null,
    },
    {
      key: "streak",
      label: "Max consecutive losses",
      hint: "Longest run of losing exits in a row — the psychological worst case.",
      value: (i: number) => {
        const m = metrics[i]!.m;
        if (m.maxConsecutiveLosses == null) return "—";
        const wins = m.maxConsecutiveWins == null ? "" : ` (best run ${m.maxConsecutiveWins})`;
        return `${m.maxConsecutiveLosses}${wins}`;
      },
      score: (i: number) => metrics[i]!.m.maxConsecutiveLosses,
      higherIsBetter: false,
    },
    {
      key: "trades",
      label: "Positions",
      hint: "Closed positions, plus any still open at the end of the tape.",
      value: (i: number) => {
        const m = metrics[i]!.m;
        if (!m.closedTrades && !m.openTrades) return "—";
        return `${m.closedTrades} closed${m.openTrades ? ` · ${m.openTrades} open` : ""}`;
      },
      score: () => null,
      higherIsBetter: null,
    },
  ] satisfies MetricRow[];


  return (
    <div className={className}>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <h4 className="text-xs font-medium text-foreground">Headline metrics</h4>
        <span className="text-[11px] text-muted-foreground">
          {metrics[0]!.m.years >= 1
            ? `${metrics[0]!.m.years.toFixed(1)} years of tape`
            : "under a year of tape — CAGR shown as raw return"}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[360px] text-xs">
          <caption className="sr-only">Headline backtest metrics for each arm</caption>
          <thead className="text-muted-foreground">
            <tr className="border-b border-border/60">
              <th scope="col" className="py-1.5 text-left font-medium">
                Metric
              </th>
              {metrics.map((a) => (
                <th key={a.label} scope="col" className="py-1.5 text-right font-medium">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className="inline-block h-2 w-2 rounded-[2px]"
                      style={{ backgroundColor: a.color }}
                    />
                    {a.label}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map((row) => {
              const scores = metrics.map((_, i) => row.score(i));
              const valid = scores.filter((s): s is number => s != null && Number.isFinite(s));
              const best =
                valid.length && row.higherIsBetter != null
                  ? row.higherIsBetter
                    ? Math.max(...valid)
                    : Math.min(...valid)
                  : null;

              return (
                <tr key={row.key} className="border-b border-border/40 last:border-0">
                  <th scope="row" className="py-1.5 pr-2 text-left font-normal text-muted-foreground">
                    <span title={row.hint}>{row.label}</span>
                  </th>
                  {metrics.map((a, i) => {
                    const s = scores[i];
                    const isBest = best != null && s != null && s === best && valid.length > 1;
                    return (
                      <td
                        key={a.label}
                        className={`py-1.5 text-right ${isBest ? "font-semibold text-foreground" : ""}`}
                      >
                        {row.value(i)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {metrics.some((a) => a.m.winRateFromDays) ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Win rate falls back to winning days where the arm doesn't track closed positions.
        </p>
      ) : null}
    </div>
  );
}
