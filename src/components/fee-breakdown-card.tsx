import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { getFeeBreakdown } from "@/lib/fee-breakdown.functions";
import { FeeDragCharts } from "@/components/fee-drag-charts";

function fmtMoney(v: number, ccy: string, digits = 2) {
  if (!Number.isFinite(v)) return "—";
  return `${ccy} ${v.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}
function fmtBps(v: number) {
  if (!Number.isFinite(v)) return "—";
  return `${v.toFixed(1)} bps`;
}
function fmtPct(v: number | null | undefined, digits = 2) {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(digits)}%`;
}
function toneClass(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return "text-muted-foreground";
  if (v > 0) return "text-emerald-500";
  if (v < 0) return "text-rose-500";
  return "text-muted-foreground";
}

export function FeeBreakdownCard({
  portfolioId,
  runToken,
  days,
}: {
  portfolioId: string;
  /** Optional cache-buster tied to a completed backtest. */
  runToken?: number;
  /** When provided, only trades in the last N days are analysed. */
  days?: number;
}) {
  const fn = useServerFn(getFeeBreakdown);
  const q = useQuery({
    queryKey: ["fee-breakdown", portfolioId, days ?? "all", runToken ?? 0],
    queryFn: () => fn({ data: { portfolio_id: portfolioId, days } }),
    staleTime: 60 * 1000,
  });

  const [tab, setTab] = useState<"charts" | "round" | "trade">("charts");
  const rt = q.data?.roundTrips ?? [];
  const pt = q.data?.perTrade ?? [];
  const s = q.data?.summary;
  const ccy = s?.currency ?? "USD";

  const topByNetLoss = useMemo(
    () => [...rt].sort((a, b) => a.netPnl - b.netPnl).slice(0, 15),
    [rt],
  );

  if (q.isLoading) {
    return (
      <Card className="mb-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Fee breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-32 animate-pulse rounded bg-muted/40" />
        </CardContent>
      </Card>
    );
  }

  if (!s || s.tradeCount === 0) {
    return (
      <Card className="mb-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Fee breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No trades yet — run a backtest or place a trade to see estimated Saxo commissions and net returns.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="mb-4">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          Fee breakdown
          <Badge variant="outline" className="text-[10px] font-normal">
            Saxo Classic estimate
          </Badge>
          {q.data?.from && q.data?.to && (
            <span className="text-xs font-normal text-muted-foreground">
              {q.data.from} → {q.data.to}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile
            label="Total commissions"
            value={fmtMoney(s.totalCommissions, ccy)}
            sub={`${s.tradeCount} trades · ${s.minFloorTradeCount} hit min-fee floor`}
          />
          <Tile
            label="Total fee drag"
            value={fmtBps(s.overallFeeDragBps)}
            sub={`Turnover ${fmtMoney(s.totalTurnover, ccy, 0)}`}
          />
          <Tile
            label="Closed net P&L"
            value={fmtMoney(s.closedNetPnl, ccy)}
            valueClass={toneClass(s.closedNetPnl)}
            sub={`Gross ${fmtMoney(s.closedGrossPnl, ccy)} · Fees ${fmtMoney(s.closedFees, ccy)}`}
          />
          <Tile
            label="Fees vs gross P&L"
            value={s.closedNetVsGrossPct == null ? "—" : `${s.closedNetVsGrossPct.toFixed(1)}%`}
            sub={`${s.closedRoundTrips} round-trip${s.closedRoundTrips === 1 ? "" : "s"}`}
          />
        </div>

        <Tabs value={tab} onValueChange={(v) => setTab(v as "round" | "trade")}>
          <TabsList>
            <TabsTrigger value="round">Round-trips ({rt.length})</TabsTrigger>
            <TabsTrigger value="trade">Per trade ({pt.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="round">
            {rt.length === 0 ? (
              <p className="text-sm text-muted-foreground py-3">
                No closed round-trips yet — buys still open have no realised net return.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase text-muted-foreground border-b">
                      <th className="py-2 pr-3">Symbol</th>
                      <th className="py-2 pr-3 text-right">Qty</th>
                      <th className="py-2 pr-3 text-right">Buy</th>
                      <th className="py-2 pr-3 text-right">Sell</th>
                      <th className="py-2 pr-3 text-right">Gross</th>
                      <th className="py-2 pr-3 text-right">Fees</th>
                      <th className="py-2 pr-3 text-right">Net</th>
                      <th className="py-2 pr-3 text-right">Net %</th>
                      <th className="py-2 pr-3 text-right">Fee drag</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rt.slice(0, 100).map((r, i) => (
                      <tr key={`${r.symbol}-${r.buyDate}-${r.sellDate}-${i}`} className="border-b last:border-b-0">
                        <td className="py-2 pr-3">
                          <div className="font-medium">{r.symbol}</div>
                          <div className="text-xs text-muted-foreground">{r.buyDate} → {r.sellDate}</div>
                        </td>
                        <td className="py-2 pr-3 text-right font-mono">{r.quantity.toLocaleString()}</td>
                        <td className="py-2 pr-3 text-right font-mono">{fmtMoney(r.buyPrice, r.currency, 4)}</td>
                        <td className="py-2 pr-3 text-right font-mono">{fmtMoney(r.sellPrice, r.currency, 4)}</td>
                        <td className={`py-2 pr-3 text-right font-mono ${toneClass(r.grossPnl)}`}>{fmtMoney(r.grossPnl, r.currency)}</td>
                        <td className="py-2 pr-3 text-right font-mono text-muted-foreground">{fmtMoney(r.totalFee, r.currency)}</td>
                        <td className={`py-2 pr-3 text-right font-mono ${toneClass(r.netPnl)}`}>{fmtMoney(r.netPnl, r.currency)}</td>
                        <td className={`py-2 pr-3 text-right font-mono ${toneClass(r.netReturnPct)}`}>{fmtPct(r.netReturnPct)}</td>
                        <td className="py-2 pr-3 text-right font-mono text-muted-foreground">{fmtBps(r.feeDragBps)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rt.length > 100 && (
                  <p className="text-xs text-muted-foreground pt-2">
                    Showing first 100 of {rt.length}. Biggest net losers:{" "}
                    {topByNetLoss.slice(0, 3).map((r) => `${r.symbol} ${fmtMoney(r.netPnl, r.currency)}`).join(", ")}
                  </p>
                )}
              </div>
            )}
          </TabsContent>

          <TabsContent value="trade">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase text-muted-foreground border-b">
                    <th className="py-2 pr-3">Date</th>
                    <th className="py-2 pr-3">Side</th>
                    <th className="py-2 pr-3">Symbol</th>
                    <th className="py-2 pr-3 text-right">Qty</th>
                    <th className="py-2 pr-3 text-right">Price</th>
                    <th className="py-2 pr-3 text-right">Notional</th>
                    <th className="py-2 pr-3 text-right">Commission</th>
                    <th className="py-2 pr-3 text-right">Per-side</th>
                  </tr>
                </thead>
                <tbody>
                  {pt.slice(-100).reverse().map((r, i) => (
                    <tr key={`${r.trade_date}-${r.symbol}-${r.side}-${i}`} className="border-b last:border-b-0">
                      <td className="py-2 pr-3">{r.trade_date}</td>
                      <td className={`py-2 pr-3 uppercase text-xs ${r.side === "buy" ? "text-emerald-500" : "text-rose-500"}`}>
                        {r.side === "buy" ? "▲ Buy" : "▼ Sell"}
                      </td>
                      <td className="py-2 pr-3 font-medium">{r.symbol}</td>
                      <td className="py-2 pr-3 text-right font-mono">{r.quantity.toLocaleString()}</td>
                      <td className="py-2 pr-3 text-right font-mono">{fmtMoney(r.price, r.currency, 4)}</td>
                      <td className="py-2 pr-3 text-right font-mono">{fmtMoney(r.notional, r.currency, 0)}</td>
                      <td className="py-2 pr-3 text-right font-mono">
                        {fmtMoney(r.commission, r.currency)}
                        {r.minFloorApplied && (
                          <span className="ml-1 text-[10px] text-amber-500" title="Saxo min-fee floor set the commission">
                            floor
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-muted-foreground">{fmtBps(r.perSideBps)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {pt.length > 100 && (
                <p className="text-xs text-muted-foreground pt-2">
                  Showing most recent 100 of {pt.length}.
                </p>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function Tile({
  label, value, sub, valueClass,
}: { label: string; value: string; sub?: string; valueClass?: string }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-xl font-semibold mt-1 font-mono ${valueClass ?? ""}`}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
    </div>
  );
}
