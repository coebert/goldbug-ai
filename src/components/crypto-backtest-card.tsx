// Crypto playbook historical backtest — replays the six approved crypto
// ETPs against the portfolio's risk-level sleeve cap and reports return /
// risk stats plus an equity+drawdown curve.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { runCryptoBacktest } from "@/lib/crypto-backtest.functions";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";

type Props = { portfolioId: string };

const fmtPct = (v: number, digits = 2) =>
  Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : "—";
const fmtGbp = (v: number) =>
  Number.isFinite(v)
    ? new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 }).format(v)
    : "—";

export function CryptoBacktestCard({ portfolioId }: Props) {
  const [years, setYears] = useState(3);
  const run = useServerFn(runCryptoBacktest);
  const mut = useMutation({
    mutationFn: () => run({ data: { portfolio_id: portfolioId, years } }),
    onError: (e: unknown) =>
      toast.error("Crypto backtest failed", {
        description: e instanceof Error ? e.message : "Unknown error",
      }),
  });

  const report = mut.data?.report;
  const chartData = (report?.equityCurve ?? []).map((p) => ({
    date: p.date,
    equity: Number(p.equity.toFixed(2)),
    drawdown: -Number((p.drawdown * 100).toFixed(2)), // negative for area under 0
    sleeve_pct: Number((p.sleeve_pct * 100).toFixed(2)),
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Crypto playbook replay backtest</CardTitle>
        <CardDescription>
          Replays daily bars for the six Saxo-tradable crypto ETPs against your
          risk-level sleeve cap and the live playbook resolver. Reports total
          return, CAGR, max drawdown and Sharpe so you can judge expected
          reward vs risk before letting the AI trade the sleeve.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1">
            <Label htmlFor="cryptobt-years">Years of history</Label>
            <Input
              id="cryptobt-years"
              type="number"
              min={1}
              max={10}
              value={years}
              onChange={(e) => setYears(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
              className="w-24"
            />
          </div>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
            {mut.isPending ? "Running…" : "Run backtest"}
          </Button>
          {mut.data ? (
            <Badge variant="secondary">
              Risk: {mut.data.risk_level ?? "balanced"} · {report?.daysReplayed ?? 0} days
            </Badge>
          ) : null}
        </div>

        {report ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Final equity" value={fmtGbp(report.finalEquity)} />
              <Stat label="Total return" value={fmtPct(report.totalReturnPct)} tone={report.totalReturnPct >= 0 ? "pos" : "neg"} />
              <Stat label="CAGR" value={fmtPct(report.cagrPct)} tone={report.cagrPct >= 0 ? "pos" : "neg"} />
              <Stat label="Max drawdown" value={fmtPct(report.maxDrawdownPct)} tone="neg" />
              <Stat label="Ann. volatility" value={fmtPct(report.volatilityPctAnnual)} />
              <Stat label="Sharpe" value={report.sharpe.toFixed(2)} tone={report.sharpe >= 0 ? "pos" : "neg"} />
              <Stat label="Win rate" value={fmtPct(report.winRate, 1)} />
              <Stat label="Closed trades" value={String(report.trades)} />
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <RegimeBadge label="Risk-on days" value={report.bucketDayCount.risk_on} total={report.daysReplayed} tone="pos" />
              <RegimeBadge label="Caution days" value={report.bucketDayCount.caution} total={report.daysReplayed} tone="warn" />
              <RegimeBadge label="Risk-off days" value={report.bucketDayCount.risk_off} total={report.daysReplayed} tone="neg" />
            </div>

            {chartData.length > 0 ? (
              <div className="space-y-3">
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                      <XAxis dataKey="date" tick={{ fontSize: 10 }} minTickGap={40} />
                      <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => fmtGbp(Number(v))} width={72} />
                      <Tooltip
                        formatter={(v: number | string, name) =>
                          name === "equity" ? [fmtGbp(Number(v)), "Equity"] : [String(v), String(name)]
                        }
                      />
                      <Line type="monotone" dataKey="equity" stroke="hsl(var(--primary))" dot={false} strokeWidth={2} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
                <div className="h-40">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                      <XAxis dataKey="date" tick={{ fontSize: 10 }} minTickGap={40} />
                      <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `${v}%`} width={40} domain={["dataMin", 0]} />
                      <Tooltip formatter={(v: number | string) => [`${v}%`, "Drawdown"]} />
                      <Area type="monotone" dataKey="drawdown" stroke="hsl(var(--destructive))" fill="hsl(var(--destructive) / 0.25)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            ) : null}

            <div>
              <div className="mb-2 text-sm font-medium">Per-ETP contribution</div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Symbol</TableHead>
                    <TableHead>Group</TableHead>
                    <TableHead className="text-right">Trades</TableHead>
                    <TableHead className="text-right">Win rate</TableHead>
                    <TableHead className="text-right">Realised PnL</TableHead>
                    <TableHead className="text-right">Final MV</TableHead>
                    <TableHead className="text-right">Contribution</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.bySymbol.map((s) => (
                    <TableRow key={s.symbol}>
                      <TableCell className="font-medium">{s.symbol}</TableCell>
                      <TableCell><Badge variant="outline">{s.group}</Badge></TableCell>
                      <TableCell className="text-right">{s.trades}</TableCell>
                      <TableCell className="text-right">{fmtPct(s.winRate, 1)}</TableCell>
                      <TableCell className="text-right">{fmtGbp(s.realisedPnl)}</TableCell>
                      <TableCell className="text-right">{fmtGbp(s.finalMv)}</TableCell>
                      <TableCell className="text-right">{fmtPct(s.contributionPct, 1)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Set a window and hit Run to replay the crypto sleeve against your risk level.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "pos" | "neg" }) {
  const cls = tone === "pos" ? "text-emerald-600" : tone === "neg" ? "text-rose-600" : "";
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold ${cls}`}>{value}</div>
    </div>
  );
}

function RegimeBadge({ label, value, total, tone }: { label: string; value: number; total: number; tone: "pos" | "warn" | "neg" }) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  const cls = tone === "pos" ? "bg-emerald-50 text-emerald-700" : tone === "warn" ? "bg-amber-50 text-amber-700" : "bg-rose-50 text-rose-700";
  return (
    <div className={`rounded-md border p-3 ${cls}`}>
      <div className="text-xs opacity-80">{label}</div>
      <div className="text-lg font-semibold">{value} <span className="text-xs opacity-80">({pct.toFixed(0)}%)</span></div>
    </div>
  );
}
