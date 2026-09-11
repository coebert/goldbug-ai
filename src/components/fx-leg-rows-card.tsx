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
import { getFxLegHygiene } from "@/lib/fx-leg-hygiene.functions";
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
 * Switch and trigger for the automatic close of spare, losing currency legs.
 * Legs still funding foreign holdings are never touched by it, so this only
 * governs money the book isn't using.
 */
function AutoCloseControl() {
  const getFn = useServerFn(getFxAutoCloseSettings);
  const setFn = useServerFn(setFxAutoCloseSettings);
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ["fx-auto-close-settings"],
    queryFn: () => getFn(),
    staleTime: 5 * 60_000,
  });
  const save = useMutation({
    mutationFn: (next: { enabled: boolean; lossPct: number }) => setFn({ data: next }),
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error("Could not save the setting", { description: res.error });
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ["fx-auto-close-settings"] });
    },
  });

  const s = settings.data;
  if (!s) return null;

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Switch
        id="fx-auto-close"
        checked={s.enabled}
        disabled={save.isPending}
        onCheckedChange={(enabled) => save.mutate({ enabled, lossPct: s.lossPct })}
      />
      <Label htmlFor="fx-auto-close" className="text-xs font-normal">
        Auto-close spare currency losing
      </Label>
      <Input
        type="number"
        step="0.1"
        min="0.1"
        max="25"
        defaultValue={s.lossPct}
        disabled={!s.enabled || save.isPending}
        className="h-7 w-16 text-xs"
        onBlur={(e) => {
          const lossPct = Number(e.currentTarget.value);
          if (Number.isFinite(lossPct) && lossPct >= 0.1 && lossPct !== s.lossPct) {
            save.mutate({ enabled: s.enabled, lossPct });
          }
        }}
      />
      <span>% or more</span>
    </div>
  );
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
  const hygieneFn = useServerFn(getFxLegHygiene);
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
  const hygiene = useQuery({
    queryKey: ["fx-leg-hygiene", portfolioId],
    queryFn: () => hygieneFn({ data: { portfolioId } }),
    staleTime: 5 * 60_000,
  });
  const hygieneBySymbol = new Map((hygiene.data?.legs ?? []).map((l) => [l.symbol, l]));

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
          <AutoCloseControl />
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
                        {hygieneBySymbol.get(l.symbol)?.recommendClose && (
                          <Badge variant="destructive" className="ml-1 text-[10px]">
                            close suggested
                          </Badge>
                        )}
                        {hygieneBySymbol.get(l.symbol) && (
                          <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
                            {hygieneBySymbol.get(l.symbol)!.reason}
                          </p>
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
          Click a row to run the rate history, backtest and stress test for that pair alone. "Close"
          flattens the leg at the live rate — the estimated exit fee is already deducted from the
          net figure shown, and the Summary tab refreshes as soon as the close settles.
        </p>
      </CardContent>

      <AlertDialog open={pending != null} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Close {pending ? `${pending.pairBase}${pending.quoteCcy}` : ""} at the live rate?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-1 text-xs">
                <p>
                  {pending?.quantity != null && pending.quantity < 0 ? "Buying back" : "Selling"}{" "}
                  {Math.abs(pending?.quantity ?? 0).toLocaleString()} {pending?.pairBase} at{" "}
                  {pending?.rate?.toFixed(4) ?? "—"}.
                </p>
                <p>
                  Estimated exit fee {(pending?.exitFeeQuote ?? 0).toFixed(2)} {pending?.quoteCcy} (
                  {(pending?.exitCostBps ?? 0).toFixed(1)}bps).
                </p>
                <p>
                  Net realised P&amp;L {money(pending?.pnlBaseNet ?? 0, baseCcy)} in {baseCcy}.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the leg</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pending) closeMutation.mutate(pending.symbol);
                setPending(null);
              }}
            >
              Close at live rate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>

  );
}
