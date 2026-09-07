import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Banknote } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SymbolTicker } from "@/components/symbol-ticker";
import { formatMoney, formatMoneySigned } from "@/lib/format-money";
import { getSymbolCashFlow } from "@/lib/symbol-cash-flow.functions";

export function SymbolCashFlowTable({ portfolioId }: { portfolioId: string }) {
  const fetchCashFlow = useServerFn(getSymbolCashFlow);
  const query = useQuery({
    queryKey: ["symbol-cash-flow", portfolioId],
    queryFn: () => fetchCashFlow({ data: { portfolioId } }),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const data = query.data;

  return (
    <Card data-testid="symbol-cash-flow-table">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Banknote className="h-4 w-4" /> Cash flow by holding
          </CardTitle>
          {data && <Badge variant="outline">{data.rows.length} symbols</Badge>}
        </div>
        <p className="text-xs text-muted-foreground">
          Full fill history in account currency. Net cash used includes fees and deducts sale proceeds.
        </p>
      </CardHeader>
      <CardContent>
        {query.isLoading && <p className="text-sm text-muted-foreground">Reading trade cash flows…</p>}
        {query.isError && <p className="text-sm text-destructive">Could not read cash flows: {(query.error as Error).message}</p>}
        {data && data.rows.length === 0 && <p className="text-sm text-muted-foreground">No completed fills yet.</p>}
        {data && data.rows.length > 0 && (
          <>
            <div className="space-y-2 md:hidden">
              {data.rows.map((row) => (
                <div key={row.symbol} className="rounded-md border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <SymbolTicker symbol={row.symbol} className="truncate font-semibold" />
                      {row.held && <Badge variant="secondary" className="text-[9px]">HELD</Badge>}
                    </div>
                    <div className="text-right">
                      <div className="text-[10px] uppercase text-muted-foreground">Net cash used</div>
                      <div className={`font-semibold tabular-nums ${row.netCashUsed >= 0 ? "text-rose-400" : "text-emerald-500"}`}>
                        {formatMoneySigned(row.netCashUsed, data.currency)}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-xs tabular-nums">
                    <div><div className="text-[10px] text-muted-foreground">Buys</div>{formatMoney(row.buyCash, data.currency)}</div>
                    <div><div className="text-[10px] text-muted-foreground">Sales back</div>{formatMoney(row.sellCash, data.currency)}</div>
                    <div><div className="text-[10px] text-muted-foreground">Fees</div>{formatMoney(row.fees, data.currency)}</div>
                  </div>
                  <div className="mt-2 text-[10px] text-muted-foreground">
                    {row.fills} fill{row.fills === 1 ? "" : "s"} · {formatMoney(row.brokerFees, data.currency)} broker-billed
                    {row.estimatedFees > 0 ? ` · ${formatMoney(row.estimatedFees, data.currency)} estimated` : ""}
                  </div>
                </div>
              ))}
            </div>

            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm tabular-nums">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="pb-2 text-left font-medium">Symbol</th>
                    <th className="pb-2 text-right font-medium">Buy cash</th>
                    <th className="pb-2 text-right font-medium">Sales back</th>
                    <th className="pb-2 text-right font-medium">Fees</th>
                    <th className="pb-2 text-right font-medium">Net cash used</th>
                    <th className="pb-2 text-right font-medium">Fills</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.symbol} className="border-b border-border/50 last:border-0">
                      <td className="py-3 pr-3">
                        <div className="flex items-center gap-2">
                          <SymbolTicker symbol={row.symbol} className="font-semibold" />
                          {row.held && <Badge variant="secondary" className="text-[9px]">HELD</Badge>}
                        </div>
                      </td>
                      <td className="py-3 text-right">{formatMoney(row.buyCash, data.currency)}</td>
                      <td className="py-3 text-right">{formatMoney(row.sellCash, data.currency)}</td>
                      <td className="py-3 text-right">
                        <div>{formatMoney(row.fees, data.currency)}</div>
                        <div className="text-[10px] text-muted-foreground">
                          {formatMoney(row.brokerFees, data.currency)} billed
                          {row.estimatedFees > 0 ? ` · ${formatMoney(row.estimatedFees, data.currency)} est.` : ""}
                        </div>
                      </td>
                      <td className={`py-3 text-right font-semibold ${row.netCashUsed >= 0 ? "text-rose-400" : "text-emerald-500"}`}>
                        {formatMoneySigned(row.netCashUsed, data.currency)}
                      </td>
                      <td className="py-3 text-right">{row.fills}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t font-semibold">
                    <td className="pt-3">Total</td>
                    <td className="pt-3 text-right">{formatMoney(data.totals.buyCash, data.currency)}</td>
                    <td className="pt-3 text-right">{formatMoney(data.totals.sellCash, data.currency)}</td>
                    <td className="pt-3 text-right">{formatMoney(data.totals.fees, data.currency)}</td>
                    <td className="pt-3 text-right">{formatMoneySigned(data.totals.netCashUsed, data.currency)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}