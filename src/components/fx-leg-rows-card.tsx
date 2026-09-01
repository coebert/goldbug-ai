import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { getFxLegQuotes, type FxLegQuote } from "@/lib/fx-leg-quotes.functions";
import { getFxStressReport } from "@/lib/fx-stress-report.functions";
import { closeFxLeg } from "@/lib/fx-leg-close.functions";


function money(n: number, ccy: string, signed = true) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: ccy,
    maximumFractionDigits: 0,
    signDisplay: signed ? "exceptZero" : "auto",
  }).format(n);
}

/**
 * One row per open FX funding leg: entry rate, live rate, unrealised P&L net
 * of the exit fee and that leg's own worst-case stress number. Selecting a row
 * filters the rest of the dashboard to that pair.
 */
export function FxLegRowsCard({
  portfolioId,
  selectedPair,
  onSelectPair,
}: {
  portfolioId: string;
  selectedPair?: string;
  onSelectPair?: (pair: string | undefined) => void;
}) {
  const quotesFn = useServerFn(getFxLegQuotes);
  const stressFn = useServerFn(getFxStressReport);
  const closeFn = useServerFn(closeFxLeg);
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<FxLegQuote | null>(null);

  const quotes = useQuery({
    queryKey: ["fx-leg-quotes", portfolioId],
    queryFn: () => quotesFn({ data: { portfolioId } }),
    refetchInterval: 60_000,
  });
  const stress = useQuery({
    queryKey: ["fx-stress-report", portfolioId],
    queryFn: () => stressFn({ data: { portfolioId, years: 20 } }),
    staleTime: 30 * 60_000,
  });

  const closeMutation = useMutation({
    mutationFn: (symbol: string) => closeFn({ data: { portfolioId, symbol } }),
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error("Could not close the leg", { description: res.detail });
        return;
      }
      toast.success(`Closed ${res.pair} at ${res.rate.toFixed(4)}`, {
        description: `${res.direction === "short" ? "Bought back" : "Sold"} ${res.amountFrom.toLocaleString()} ${res.fromCcy} → ${res.amountTo.toLocaleString()} ${res.toCcy}. Fee ${res.feeQuote.toFixed(2)} ${res.toCcy === res.fromCcy ? "" : ""}, net P&L ${res.pnlQuoteNet.toFixed(2)}.`,
      });
      // Refresh every surface that reads holdings/cash — Summary tab included.
      void queryClient.invalidateQueries();
    },
    onError: (e: unknown) =>
      toast.error("Could not close the leg", {
        description: e instanceof Error ? e.message : "Unexpected error",
      }),
  });

  const baseCcy = quotes.data?.baseCcy ?? "GBP";
  const legs = quotes.data?.legs ?? [];
  const stressByPair = new Map(
    (stress.data?.legs ?? []).filter((l) => l.actual && !l.error).map((l) => [l.pair, l]),
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Open FX legs</CardTitle>
          {selectedPair && (
            <Button
              size="sm"
              variant="ghost"

              className="h-7 px-2 text-xs"
              onClick={() => onSelectPair?.(undefined)}
            >
              Clear filter
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {quotes.isLoading && <p className="text-xs text-muted-foreground">Marking legs…</p>}
        {!quotes.isLoading && legs.length === 0 && (
          <p className="text-xs text-muted-foreground">No open FX funding legs right now.</p>
        )}
        {legs.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-2 font-medium">Pair</th>
                  <th className="py-1 pr-2 font-medium">Side</th>
                  <th className="py-1 pr-2 text-right font-medium">Entry</th>
                  <th className="py-1 pr-2 text-right font-medium">Live</th>
                  <th className="py-1 pr-2 text-right font-medium">Notional ({baseCcy})</th>
                  <th className="py-1 pr-2 text-right font-medium">Close now (net)</th>
                  <th className="py-1 pr-2 text-right font-medium">Stress worst</th>
                  <th className="py-1 text-right font-medium">Close</th>

                </tr>
              </thead>
              <tbody>
                {legs.map((l) => {
                  const pair = `${l.pairBase}${l.quoteCcy}`;
                  const st = stressByPair.get(pair);
                  const active = selectedPair === pair;
                  return (
                    <tr
                      key={l.symbol}
                      onClick={() => onSelectPair?.(active ? undefined : pair)}
                      className={`cursor-pointer border-t border-border/50 hover:bg-muted/50 ${
                        active ? "bg-muted" : ""
                      }`}
                    >
                      <td className="py-1.5 pr-2 font-medium">{pair}</td>
                      <td className="py-1.5 pr-2">
                        <Badge
                          variant={l.quantity < 0 ? "destructive" : "secondary"}
                          className="text-[10px]"
                        >
                          {l.quantity < 0 ? "Short" : "Long"} {l.pairBase}
                        </Badge>
                        {l.stale && (
                          <Badge variant="outline" className="ml-1 text-[10px]">
                            stale
                          </Badge>
                        )}
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{l.avgCost.toFixed(4)}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">
                        {l.rate == null ? "—" : l.rate.toFixed(4)}
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">
                        {money(Math.abs(l.notionalBase), baseCcy, false)}
                      </td>
                      <td
                        className={`py-1.5 pr-2 text-right tabular-nums ${
                          l.pnlBaseNet < 0
                            ? "text-destructive"
                            : "text-emerald-600 dark:text-emerald-400"
                        }`}
                      >
                        {money(l.pnlBaseNet, baseCcy)}
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums text-destructive">
                        {st ? money(st.report.worstCaseBase, baseCcy) : "—"}
                      </td>
                      <td className="py-1.5 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs"
                          disabled={l.rate == null || l.stale || closeMutation.isPending}
                          onClick={(e) => {
                            e.stopPropagation();
                            setPending(l);
                          }}
                        >
                          {closeMutation.isPending && closeMutation.variables === l.symbol
                            ? "Closing…"
                            : "Close"}
                        </Button>
                      </td>
                    </tr>
                  );
                })}

              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
          Click a row to run the rate history, backtest and stress test for that pair alone.
        </p>
      </CardContent>
    </Card>
  );
}
