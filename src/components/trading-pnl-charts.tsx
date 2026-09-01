import { useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// High-chroma, colour-blind-safe pair (Okabe-Ito) so the P&L and drawdown
// series stay separable on both themes.
const EQUITY = "#0072B2";
const LOSS = "#D55E00";
const GAIN = "#009E73";

export type EquityPoint = { date: string; value: number };

function currency(ccy: string, digits = 0) {
  return (n: number) =>
    new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: ccy || "GBP",
      maximumFractionDigits: digits,
    }).format(n);
}

/**
 * P&L curve, drawdown-from-peak and per-position risk concentration for the
 * trading dashboard. All three read the same authoritative snapshot series the
 * portfolio pages use, so the desk view can't disagree with the overview.
 */
export function TradingPnlCharts({
  equity,
  baseline,
  currency: ccy,
  positions,
}: {
  equity: EquityPoint[];
  /** Starting capital; P&L is measured against it. */
  baseline: number;
  currency: string;
  positions: Array<{ symbol: string; value: number; pnl: number | null }>;
}) {
  const fmt = currency0(ccy);

  const series = useMemo(() => {
    let peak = -Infinity;
    return equity.map((p) => {
      peak = Math.max(peak, p.value);
      return {
        date: p.date,
        pnl: p.value - baseline,
        drawdown: peak > 0 ? -((peak - p.value) / peak) * 100 : 0,
      };
    });
  }, [equity, baseline]);

  const totalValue = positions.reduce((s, p) => s + Math.abs(p.value), 0);
  const risk = useMemo(
    () =>
      positions
        .map((p) => ({
          symbol: p.symbol,
          weight: totalValue > 0 ? (Math.abs(p.value) / totalValue) * 100 : 0,
          pnl: p.pnl ?? 0,
        }))
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 12),
    [positions, totalValue],
  );

  const maxDd = series.reduce((m, p) => Math.min(m, p.drawdown), 0);
  const lastPnl = series.length ? series[series.length - 1]!.pnl : 0;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            P&amp;L since inception ·{" "}
            <span className={lastPnl < 0 ? "text-destructive" : "text-emerald-600 dark:text-emerald-400"}>
              {fmt(lastPnl)}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="h-56">
          {series.length < 2 ? (
            <p className="text-xs text-muted-foreground">Not enough snapshots yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={series} margin={{ top: 8, right: 12, bottom: 18, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} minTickGap={40}
                  label={{ value: "Date", position: "insideBottom", offset: -8, fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} width={64} tickFormatter={(v: number) => fmt(v)}
                  label={{ value: "P&L", angle: -90, position: "insideLeft", fontSize: 10 }} />
                <Tooltip formatter={(v: number) => fmt(v)} />
                <Area type="monotone" dataKey="pnl" stroke={EQUITY} fill={EQUITY} fillOpacity={0.15} strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            Drawdown from peak · worst {maxDd.toFixed(1)}%
          </CardTitle>
        </CardHeader>
        <CardContent className="h-56">
          {series.length < 2 ? (
            <p className="text-xs text-muted-foreground">Not enough snapshots yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={series} margin={{ top: 8, right: 12, bottom: 18, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} minTickGap={40}
                  label={{ value: "Date", position: "insideBottom", offset: -8, fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} width={52} tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                  label={{ value: "Drawdown", angle: -90, position: "insideLeft", fontSize: 10 }} />
                <Tooltip formatter={(v: number) => `${Number(v).toFixed(2)}%`} />
                <Line type="monotone" dataKey="drawdown" stroke={LOSS} dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Risk concentration by position</CardTitle>
        </CardHeader>
        <CardContent className="h-56">
          {risk.length === 0 ? (
            <p className="text-xs text-muted-foreground">No open positions.</p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={risk} margin={{ top: 8, right: 12, bottom: 24, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis dataKey="symbol" tick={{ fontSize: 10 }} interval={0} angle={-30} textAnchor="end" height={48} />
                <YAxis tick={{ fontSize: 10 }} width={48} tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                  label={{ value: "% of book", angle: -90, position: "insideLeft", fontSize: 10 }} />
                <Tooltip formatter={(v: number) => `${Number(v).toFixed(1)}% of book`} />
                <Bar dataKey="weight">
                  {risk.map((r) => (
                    <Cell key={r.symbol} fill={r.pnl < 0 ? LOSS : GAIN} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function currency0(ccy: string) {
  return currency(ccy, 0);
}
