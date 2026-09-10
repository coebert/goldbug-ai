import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Activity, Radio } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SymbolTicker } from "@/components/symbol-ticker";
import { formatMoney, formatMoneySigned } from "@/lib/format-money";
import { getTradeImpact } from "@/lib/trade-impact.functions";
import { useLiveFillStream } from "@/hooks/use-live-fill-stream";

const signClass = (value: number) =>
  value > 0 ? "text-emerald-500" : value < 0 ? "text-rose-400" : "text-muted-foreground";

function timeLabel(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  });
}

export function TradeImpactPanel({ portfolioId }: { portfolioId: string }) {
  const fetchImpact = useServerFn(getTradeImpact);
  const query = useQuery({
    queryKey: ["trade-impact", portfolioId],
    queryFn: () => fetchImpact({ data: { portfolioId, limit: 30 } }),
    staleTime: 15_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const stream = useLiveFillStream(portfolioId, () => void query.refetch());
  const data = query.data;

  return (
    <Card data-testid="trade-impact-panel">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4" /> Trade impact (real money)
          </CardTitle>
          <div className="flex items-center gap-2">
            {stream.connected && (
              <Badge variant="outline" className="gap-1 text-[10px]">
                <Radio className="h-3 w-3 text-emerald-500" /> Live
              </Badge>
            )}
            {data && <Badge variant="outline">{data.summary.trades} trades</Badge>}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          What each real fill did to your cash, your charges and your profit. Updates the moment a
          trade fills.
        </p>
      </CardHeader>
      <CardContent>
        {query.isLoading && <p className="text-sm text-muted-foreground">Reading your fills…</p>}
        {query.isError && (
          <p className="text-sm text-destructive">
            Could not read trade impact: {(query.error as Error).message}
          </p>
        )}
        {data && data.summary.trades === 0 && (
          <p className="text-sm text-muted-foreground">No real fills yet.</p>
        )}
        {data && data.summary.trades > 0 && (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-md border p-3">
                <div className="text-[10px] uppercase text-muted-foreground">Net cash moved</div>
                <div className={`text-sm font-semibold tabular-nums ${signClass(data.summary.netCashBase)}`}>
                  {formatMoneySigned(data.summary.netCashBase, data.currency)}
                </div>
              </div>
              <div className="rounded-md border p-3">
                <div className="text-[10px] uppercase text-muted-foreground">Charges paid</div>
                <div className="text-sm font-semibold tabular-nums">
                  {formatMoney(data.summary.feesBase, data.currency)}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {formatMoney(data.summary.brokerFeesBase, data.currency)} billed ·{" "}
                  {formatMoney(data.summary.estimatedFeesBase, data.currency)} estimated
                </div>
              </div>
              <div className="rounded-md border p-3">
                <div className="text-[10px] uppercase text-muted-foreground">Profit banked</div>
                <div className={`text-sm font-semibold tabular-nums ${signClass(data.summary.realisedBase)}`}>
                  {formatMoneySigned(data.summary.realisedBase, data.currency)}
                </div>
              </div>
              <div className="rounded-md border p-3">
                <div className="text-[10px] uppercase text-muted-foreground">All-in profit</div>
                <div className={`text-sm font-semibold tabular-nums ${signClass(data.summary.totalProfitBase)}`}>
                  {formatMoneySigned(data.summary.totalProfitBase, data.currency)}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  incl. {formatMoneySigned(data.summary.unrealisedBase, data.currency)} still open
                </div>
              </div>
            </div>

            <div className="mt-4 space-y-2 md:hidden">
              {data.rows.map((row) => (
                <div key={row.id} className="rounded-md border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <Badge variant={row.side === "buy" ? "secondary" : "outline"} className="text-[9px] uppercase">
                        {row.side}
                      </Badge>
                      <SymbolTicker symbol={row.symbol} className="truncate font-semibold" />
                    </div>
                    <div className={`text-right text-sm font-semibold tabular-nums ${signClass(row.cashDeltaBase)}`}>
                      {formatMoneySigned(row.cashDeltaBase, data.currency)}
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-xs tabular-nums">
                    <div>
                      <div className="text-[10px] text-muted-foreground">Charge</div>
                      {formatMoney(row.feeBase, data.currency)}
                    </div>
                    <div>
                      <div className="text-[10px] text-muted-foreground">Profit</div>
                      <span className={row.realisedBase == null ? "" : signClass(row.realisedBase)}>
                        {row.realisedBase == null ? "—" : formatMoneySigned(row.realisedBase, data.currency)}
                      </span>
                    </div>
                    <div>
                      <div className="text-[10px] text-muted-foreground">Held after</div>
                      {row.positionAfter}
                    </div>
                  </div>
                  <div className="mt-2 text-[10px] text-muted-foreground">
                    {timeLabel(row.filledAt)} · {row.quantity} @ {formatMoney(row.priceBase, data.currency)} ·{" "}
                    {row.feeSource === "broker" ? "broker-billed" : "estimated"} charge
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-[10px] uppercase text-muted-foreground">
                    <th className="py-2 text-left font-medium">Filled</th>
                    <th className="py-2 text-left font-medium">Trade</th>
                    <th className="py-2 text-right font-medium">Cash</th>
                    <th className="py-2 text-right font-medium">Charge</th>
                    <th className="py-2 text-right font-medium">Profit banked</th>
                    <th className="py-2 text-right font-medium">Running cash</th>
                    <th className="py-2 text-right font-medium">Running profit</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.id} className="border-b last:border-0">
                      <td className="py-2 text-xs text-muted-foreground">{timeLabel(row.filledAt)}</td>
                      <td className="py-2">
                        <div className="flex items-center gap-2">
                          <Badge variant={row.side === "buy" ? "secondary" : "outline"} className="text-[9px] uppercase">
                            {row.side}
                          </Badge>
                          <SymbolTicker symbol={row.symbol} className="font-medium" />
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {row.quantity} @ {formatMoney(row.priceBase, data.currency)}
                          </span>
                        </div>
                      </td>
                      <td className={`py-2 text-right tabular-nums ${signClass(row.cashDeltaBase)}`}>
                        {formatMoneySigned(row.cashDeltaBase, data.currency)}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatMoney(row.feeBase, data.currency)}
                        <span className="ml-1 text-[10px] text-muted-foreground">
                          {row.feeSource === "broker" ? "billed" : "est."}
                        </span>
                      </td>
                      <td className={`py-2 text-right tabular-nums ${row.realisedBase == null ? "" : signClass(row.realisedBase)}`}>
                        {row.realisedBase == null ? "—" : formatMoneySigned(row.realisedBase, data.currency)}
                      </td>
                      <td className={`py-2 text-right tabular-nums ${signClass(row.runningCashBase)}`}>
                        {formatMoneySigned(row.runningCashBase, data.currency)}
                      </td>
                      <td className={`py-2 text-right tabular-nums ${signClass(row.runningRealisedBase)}`}>
                        {formatMoneySigned(row.runningRealisedBase, data.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {data.open.length > 0 && (
              <div className="mt-4 rounded-md border p-3">
                <div className="text-[10px] uppercase text-muted-foreground">Still open</div>
                <div className="mt-2 space-y-1 text-xs tabular-nums">
                  {data.open.map((position) => (
                    <div key={position.symbol} className="flex items-center justify-between gap-2">
                      <SymbolTicker symbol={position.symbol} className="truncate font-medium" />
                      <span className="text-muted-foreground">
                        {position.quantity} @ {formatMoney(position.avgCostBase, data.currency)} cost
                      </span>
                      <span className={position.unrealisedBase == null ? "text-muted-foreground" : signClass(position.unrealisedBase)}>
                        {position.unrealisedBase == null
                          ? "no price"
                          : formatMoneySigned(position.unrealisedBase, data.currency)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
