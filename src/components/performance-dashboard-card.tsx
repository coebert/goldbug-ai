import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BarChart3 } from "lucide-react";
import {
  computeBacktestMetrics,
  perAssetContribution,
  type EquityPoint,
  type TradeRow,
  type PerAssetContribution,
} from "@/lib/backtest-metrics";
import { formatUk } from "@/lib/uk-time";

/**
 * Strategy performance dashboard for a SIM/backtest portfolio.
 *
 * Summarises the simulated run (default is a £1000 starter pot but the
 * component adapts to whatever `startingCash` / `currency` the portfolio
 * uses) with:
 *   • Realised P&L, net of user deposits, and total return %
 *   • Max drawdown (peak → trough dates)
 *   • Round-trip win rate + best/worst day
 *   • Per-asset contribution table (realised PnL, win rate, open exposure)
 *
 * Pure client-side: reuses the FIFO/MDD helpers from backtest-metrics.ts,
 * so numbers match the backtest card exactly.
 */

type Deposit = { date: string; amount: number };

interface Props {
  startingCash: number;
  currency: string;
  equity: EquityPoint[];
  trades: TradeRow[];
  deposits?: Deposit[];
}

export function PerformanceDashboardCard({
  startingCash,
  currency,
  equity,
  trades,
  deposits = [],
}: Props) {
  const fmtCcy = useMemo(
    () =>
      new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency,
        maximumFractionDigits: 2,
      }),
    [currency],
  );
  const fmtNum = (n: number, digits = 2) =>
    Number.isFinite(n) ? n.toFixed(digits) : "—";

  const {
    metrics,
    perAsset,
    finalValue,
    depositsNet,
    netPnl,
    netReturnPct,
  } = useMemo(() => {
    const values = equity
      .filter((e) => Number.isFinite(Number(e.total_value)))
      .map((e) => ({
        snapshot_date: e.snapshot_date,
        total_value: Number(e.total_value),
      }));
    const m = computeBacktestMetrics(values, trades, startingCash);
    const pa = perAssetContribution(trades);
    const last = values.length ? values[values.length - 1].total_value : startingCash;
    const depNet = deposits.reduce((a, d) => a + (Number(d.amount) || 0), 0);
    const base = startingCash + depNet;
    return {
      metrics: m,
      perAsset: pa,
      finalValue: last,
      depositsNet: depNet,
      netPnl: last - base,
      netReturnPct: base > 0 ? ((last - base) / base) * 100 : 0,
    };
  }, [equity, trades, startingCash, deposits]);

  const sign = (n: number) =>
    n > 0
      ? "text-emerald-600 dark:text-emerald-400"
      : n < 0
        ? "text-destructive"
        : "text-muted-foreground";

  const winRate = metrics.winRatePct;
  const winRateColor =
    winRate == null
      ? "text-muted-foreground"
      : winRate >= 50
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-amber-600 dark:text-amber-400";

  const hasData = equity.length > 0 || trades.length > 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <BarChart3 className="h-4 w-4 text-primary" aria-hidden />
          Performance dashboard
          <Badge variant="outline" className="ml-1 font-mono text-[10px]">
            {fmtCcy.format(startingCash)} start
          </Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Strategy quality summary for the simulated run — P&amp;L is net of
          any funds you added mid-run so it reflects pure trading performance.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {!hasData && (
          <p className="text-sm text-muted-foreground">
            No equity snapshots or trades yet — run the AI or a backtest to
            populate this dashboard.
          </p>
        )}

        {hasData && (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Metric
                label="Net P&L"
                value={fmtCcy.format(netPnl)}
                sub={`${netReturnPct >= 0 ? "+" : ""}${fmtNum(netReturnPct)}% vs ${fmtCcy.format(
                  startingCash + depositsNet,
                )}`}
                cls={sign(netPnl)}
              />
              <Metric
                label="Total return"
                value={`${metrics.totalReturnPct >= 0 ? "+" : ""}${fmtNum(metrics.totalReturnPct)}%`}
                sub={`Now ${fmtCcy.format(finalValue)}`}
                cls={sign(metrics.totalReturnPct)}
              />
              <Metric
                label="Max drawdown"
                value={`${fmtNum(metrics.maxDrawdownPct)}%`}
                sub={
                  metrics.maxDrawdownPeakDate && metrics.maxDrawdownTroughDate
                    ? `${formatUk(metrics.maxDrawdownPeakDate)} → ${formatUk(
                        metrics.maxDrawdownTroughDate,
                      )}`
                    : "No drawdown yet"
                }
                cls={metrics.maxDrawdownPct < 0 ? "text-destructive" : "text-muted-foreground"}
              />
              <Metric
                label="Win rate"
                value={winRate == null ? "—" : `${fmtNum(winRate, 1)}%`}
                sub={(() => {
                  const be = Math.max(0, metrics.trades - metrics.wins - metrics.losses);
                  const beSuffix = be > 0 ? ` · ${be} breakeven` : "";
                  return `${metrics.wins}W / ${metrics.losses}L · ${metrics.trades} round-trips${beSuffix}`;
                })()}
                cls={winRateColor}
              />
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <MiniStat
                label="Sharpe (ann.)"
                value={fmtNum(metrics.sharpe)}
                hint={
                  metrics.sharpeCI
                    ? `95% CI ${fmtNum(metrics.sharpeCI.low)} – ${fmtNum(metrics.sharpeCI.high)}`
                    : undefined
                }
              />
              <MiniStat
                label="Volatility (ann.)"
                value={`${fmtNum(metrics.volatilityPct)}%`}
              />
              <MiniStat
                label="Best day"
                value={`+${fmtNum(metrics.bestDayPct)}%`}
              />
              <MiniStat
                label="Worst day"
                value={`${fmtNum(metrics.worstDayPct)}%`}
              />
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <h4 className="text-sm font-medium">Per-asset contribution</h4>
                <span className="text-[11px] text-muted-foreground">
                  Realised PnL from FIFO-matched round-trips
                </span>
              </div>
              {perAsset.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No trades yet — nothing to attribute.
                </p>
              ) : (
                <div className="overflow-x-auto rounded-lg border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">Symbol</th>
                        <th className="px-3 py-2 text-right font-medium">Realised P&amp;L</th>
                        <th className="px-3 py-2 text-right font-medium">Round-trips</th>
                        <th className="px-3 py-2 text-right font-medium">Win rate</th>
                        <th className="px-3 py-2 text-right font-medium">Bought</th>
                        <th className="px-3 py-2 text-right font-medium">Sold</th>
                        <th className="px-3 py-2 text-right font-medium">Open exposure</th>
                      </tr>
                    </thead>
                    <tbody>
                      {perAsset.map((row) => (
                        <PerAssetRow
                          key={row.symbol}
                          row={row}
                          fmtCcy={fmtCcy}
                          fmtNum={fmtNum}
                        />
                      ))}
                    </tbody>
                    <tfoot className="border-t bg-muted/30 text-xs">
                      <tr>
                        <td className="px-3 py-2 font-medium">Total</td>
                        <td className={`px-3 py-2 text-right font-medium tabular-nums ${sign(metrics.grossRealizedPnl)}`}>
                          {fmtCcy.format(metrics.grossRealizedPnl)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{metrics.trades}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {winRate == null ? "—" : `${fmtNum(winRate, 1)}%`}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {fmtCcy.format(perAsset.reduce((a, r) => a + r.bought, 0))}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {fmtCcy.format(perAsset.reduce((a, r) => a + r.sold, 0))}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {fmtCcy.format(perAsset.reduce((a, r) => a + r.openCostBasis, 0))}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
              <p className="mt-2 text-[11px] text-muted-foreground">
                Open exposure is the remaining cost basis of un-closed lots
                (FIFO). Realised P&amp;L excludes fees/dividends — trading
                performance only.
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({
  label,
  value,
  sub,
  cls,
}: {
  label: string;
  value: string;
  sub?: string;
  cls?: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className={`mt-1 text-lg font-semibold tabular-nums ${cls ?? ""}`}>
        {value}
      </div>
      {sub && (
        <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>
      )}
    </div>
  );
}

function MiniStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-md border bg-muted/20 p-2 text-center">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums">{value}</div>
      {hint && (
        <div className="mt-0.5 text-[10px] text-muted-foreground">{hint}</div>
      )}
    </div>
  );
}

function PerAssetRow({
  row,
  fmtCcy,
  fmtNum,
}: {
  row: PerAssetContribution;
  fmtCcy: Intl.NumberFormat;
  fmtNum: (n: number, d?: number) => string;
}) {
  const cls =
    row.realizedPnl > 0
      ? "text-emerald-600 dark:text-emerald-400"
      : row.realizedPnl < 0
        ? "text-destructive"
        : "text-muted-foreground";
  return (
    <tr className="border-t">
      <td className="px-3 py-2 font-mono font-medium">{row.symbol}</td>
      <td className={`px-3 py-2 text-right tabular-nums ${cls}`}>
        {fmtCcy.format(row.realizedPnl)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{row.roundTrips}</td>
      <td className="px-3 py-2 text-right tabular-nums">
        {row.winRatePct == null ? "—" : `${fmtNum(row.winRatePct, 0)}%`}
        {row.roundTrips > 0 && (
          <span className="ml-1 text-[10px] text-muted-foreground">
            ({row.wins}/{row.losses})
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
        {fmtCcy.format(row.bought)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
        {fmtCcy.format(row.sold)}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {row.openQty > 0 ? fmtCcy.format(row.openCostBasis) : "—"}
      </td>
    </tr>
  );
}
