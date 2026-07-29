// Per-currency wallet and holdings exposure. Shows JPY/AUD/USD/etc. balances
// alongside the portfolio base currency so the user can see foreign cash and
// positions separately without them being flattened into a single base total.

import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Globe, AlertTriangle } from "lucide-react";
import { getMultiCurrencyExposure } from "@/lib/multi-currency-exposure.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface Props {
  portfolioId: string;
  active?: boolean;
}

function fmtCcy(amount: number, ccy: string) {
  try {
    // JPY has no minor units; render whole yen.
    const dp = ccy === "JPY" ? 0 : 2;
    return amount.toLocaleString("en-GB", {
      style: "currency",
      currency: ccy,
      minimumFractionDigits: dp,
      maximumFractionDigits: dp,
    });
  } catch {
    return `${amount.toFixed(2)} ${ccy}`;
  }
}

function fmtPct(x: number) {
  return `${(x * 100).toFixed(1)}%`;
}

export function MultiCurrencyExposureCard({ portfolioId, active = true }: Props) {
  const fetchExposure = useServerFn(getMultiCurrencyExposure);
  const q = useQuery({
    queryKey: ["multi-ccy-exposure", portfolioId],
    queryFn: () => fetchExposure({ data: { portfolioId } }),
    enabled: !!portfolioId && active,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const data = q.data;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Globe className="h-4 w-4" />
          Multi-currency cash & exposure
          {data?.usedStaleRate && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="destructive" className="ml-auto gap-1 text-[10px]">
                    <AlertTriangle className="h-3 w-3" /> Stale FX
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  Some conversions used a stale or fallback rate: {data.staleRatePairs.join(", ")}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {q.isLoading && (
          <div className="text-muted-foreground">Loading currency breakdown…</div>
        )}
        {q.isError && (
          <div className="text-destructive">
            Failed to load exposure: {String((q.error as Error)?.message ?? q.error)}
          </div>
        )}
        {data && data.rows.length === 0 && (
          <div className="text-muted-foreground">
            No cash or holdings recorded yet.
          </div>
        )}
        {data && data.rows.length > 0 && (
          <>
            <div className="mb-3 grid grid-cols-3 gap-2 rounded-md bg-muted/40 p-2 text-xs">
              <div>
                <div className="text-muted-foreground">Total equity</div>
                <div className="font-semibold">
                  {fmtCcy(data.totalEquityBase, data.baseCcy)}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Cash</div>
                <div className="font-semibold">
                  {fmtCcy(data.totalCashBase, data.baseCcy)}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Holdings</div>
                <div className="font-semibold">
                  {fmtCcy(data.totalHoldingsBase, data.baseCcy)}
                </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr className="border-b">
                    <th className="py-1 text-left font-medium">Ccy</th>
                    <th className="py-1 text-right font-medium">Cash (native)</th>
                    <th className="py-1 text-right font-medium">Holdings (native)</th>
                    <th className="py-1 text-right font-medium">
                      Total in {data.baseCcy}
                    </th>
                    <th className="py-1 text-right font-medium">% equity</th>
                    <th className="py-1 text-right font-medium">FX→{data.baseCcy}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.currency} className="border-b last:border-b-0">
                      <td className="py-1.5">
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold">{r.currency}</span>
                          {r.currency === data.baseCcy && (
                            <Badge variant="outline" className="text-[9px]">base</Badge>
                          )}
                          {r.fxStale && r.currency !== data.baseCcy && (
                            <Badge variant="destructive" className="text-[9px]">stale</Badge>
                          )}
                        </div>
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {fmtCcy(r.cashNative, r.currency)}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {r.holdingsNative > 0 ? fmtCcy(r.holdingsNative, r.currency) : "—"}
                      </td>
                      <td className="py-1.5 text-right font-medium tabular-nums">
                        {fmtCcy(r.totalBase, data.baseCcy)}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                        {fmtPct(r.pctOfEquity)}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                        {r.currency === data.baseCcy
                          ? "1.0000"
                          : r.fxRateToBase.toFixed(4)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {!data.fxEnabled && (
              <div className="mt-2 text-[11px] text-muted-foreground">
                FX conversions are disabled on this portfolio. Foreign balances
                are shown for transparency but the AI will not rebalance them.
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
