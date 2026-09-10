import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Receipt } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SymbolTicker } from "@/components/symbol-ticker";
import { formatMoney, formatMoneySigned } from "@/lib/format-money";
import { getTradeCostBreakdown } from "@/lib/trade-cost-breakdown.functions";
import { useLiveFillStream } from "@/hooks/use-live-fill-stream";

function dayLabel(iso: string) {
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

export function TradeCostBreakdownCard({ portfolioId }: { portfolioId: string }) {
  const fetchBreakdown = useServerFn(getTradeCostBreakdown);
  const query = useQuery({
    queryKey: ["trade-cost-breakdown", portfolioId],
    queryFn: () => fetchBreakdown({ data: { portfolioId, limit: 40 } }),
    staleTime: 30_000,
    refetchInterval: 120_000,
  });
  useLiveFillStream(portfolioId, () => void query.refetch());

  const data = query.data;
  const s = data?.summary;
  const ccy = data?.currency ?? "GBP";
  // The broker often bills a single total with no line detail. Showing three
  // permanently empty columns would read as "these cost nothing" rather than
  // "these were never itemised", so collapse them until detail exists.
  const itemised = !!s && s.commissionBase + s.taxBase + s.exchangeBase > 0;

  return (
    <Card data-testid="trade-cost-breakdown-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Receipt className="h-4 w-4" /> Dealing costs per trade
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          What each trade cost to deal — commission, tax and exchange charges — and the
          cash left in the account after it.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
        {query.error && <p className="text-sm text-rose-400">Couldn&apos;t load dealing costs.</p>}
        {s && s.trades === 0 && <p className="text-sm text-muted-foreground">No trades yet.</p>}

        {data && s && s.trades > 0 && (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <p className="text-xs text-muted-foreground">Charges paid</p>
                <p className="text-lg font-semibold">{formatMoney(s.totalCostBase, ccy)}</p>
                <p className="text-xs text-muted-foreground">{s.costBps.toFixed(1)}bps of traded value</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">
                  {itemised ? "Commission" : "Average per trade"}
                </p>
                <p className="text-lg font-semibold">
                  {formatMoney(
                    itemised ? s.commissionBase : s.totalCostBase / Math.max(1, s.trades),
                    ccy,
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {itemised
                    ? `tax ${formatMoney(s.taxBase, ccy)} · exchange ${formatMoney(s.exchangeBase, ccy)}`
                    : "broker bills one total, no line detail"}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Billed by broker</p>
                <p className="text-lg font-semibold">{formatMoney(s.brokerBilledBase, ccy)}</p>
                <p className="text-xs text-muted-foreground">
                  estimated {formatMoney(s.estimatedBase, ccy)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Cash left now</p>
                <p className="text-lg font-semibold">{formatMoney(s.cashLeftBase, ccy)}</p>
                <p className="text-xs text-muted-foreground">
                  {s.trades} trade{s.trades === 1 ? "" : "s"}
                </p>
              </div>
            </div>

            {s.worst && (
              <p className="text-xs text-muted-foreground">
                Priciest ticket: {s.worst.symbol} at {s.worst.costBps.toFixed(0)}bps (
                {formatMoney(s.worst.totalCostBase, ccy)}).
              </p>
            )}

            <div className="overflow-x-auto">
              <table className={`w-full text-sm ${itemised ? "min-w-[720px]" : "min-w-[480px]"}`}>
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="py-2 text-left font-medium">Trade</th>
                    <th className="py-2 text-right font-medium">Value</th>
                    {itemised && (
                      <>
                        <th className="py-2 text-right font-medium">Commission</th>
                        <th className="py-2 text-right font-medium">Tax</th>
                        <th className="py-2 text-right font-medium">Exchange</th>
                        <th className="py-2 text-right font-medium">Other</th>
                      </>
                    )}
                    <th className="py-2 text-right font-medium">Charges</th>
                    <th className="py-2 text-right font-medium">Cash left</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="py-2">
                        <div className="flex items-center gap-2">
                          <SymbolTicker symbol={r.symbol} />
                          <Badge variant={r.side === "buy" ? "secondary" : "outline"}>
                            {r.side === "buy" ? "Bought" : "Sold"}
                          </Badge>
                          {r.feeSource !== "broker" && (
                            <Badge variant="outline" className="text-[10px]">
                              estimated
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {r.quantity} @ {formatMoney(r.priceBase, ccy)} · {dayLabel(r.filledAt)}
                        </p>
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatMoney(r.grossBase, ccy)}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatMoney(r.commissionBase, ccy)}
                      </td>
                      <td className="py-2 text-right tabular-nums">{formatMoney(r.taxBase, ccy)}</td>
                      <td className="py-2 text-right tabular-nums">
                        {formatMoney(r.exchangeBase, ccy)}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatMoney(r.otherBase, ccy)}
                      </td>
                      <td className="py-2 text-right tabular-nums font-medium">
                        {formatMoney(r.totalCostBase, ccy)}
                        <span className="block text-xs text-muted-foreground">
                          {r.costBps.toFixed(0)}bps
                        </span>
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatMoney(r.cashLeftBase, ccy)}
                        <span className="block text-xs text-muted-foreground">
                          {formatMoneySigned(r.cashDeltaBase, ccy)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-xs text-muted-foreground">
              Cash left is worked back from today&apos;s balance, so the most recent rows are
              exact and older ones ignore any money paid in or taken out since.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
