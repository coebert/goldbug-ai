import { useMemo } from "react";
import { armHeadlineMetrics } from "@/lib/backtest/arm-metrics";
import type { ArmResult } from "@/lib/backtest/insider-nudge-replay";

type Arm = { result: ArmResult; label: string; color: string };

function fmtPct(v: number | null, digits = 2) {
  if (v == null || !Number.isFinite(v)) return "—";
  const s = v.toFixed(digits);
  return `${v > 0 ? "+" : ""}${s}%`;
}

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
  ];

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
              const best = valid.length
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
