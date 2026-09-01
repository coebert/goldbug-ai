import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getFxLegQuotes } from "@/lib/fx-leg-quotes.functions";
import { getFxStressReport } from "@/lib/fx-stress-report.functions";

function money(n: number, ccy: string, signed = true) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: ccy,
    maximumFractionDigits: 0,
    signDisplay: signed ? "exceptZero" : "auto",
  }).format(n);
}

/**
 * Single top-of-page read of how much cash the open FX funding legs put at
 * risk: gross notional, the P&L if everything closed now (net of exit fees)
 * and the deepest modelled loss from the stress scenarios.
 */
export function FxCashAtRiskCard({ portfolioId }: { portfolioId: string }) {
  const quotesFn = useServerFn(getFxLegQuotes);
  const stressFn = useServerFn(getFxStressReport);

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

  const baseCcy = quotes.data?.baseCcy ?? "GBP";
  const legs = quotes.data?.legs ?? [];
  const grossNotional = legs.reduce((s, l) => s + Math.abs(l.notionalBase), 0);
  const closeNow = legs.reduce((s, l) => s + l.pnlBaseNet, 0);
  const exitFees = legs.reduce((s, l) => s + Math.abs(l.exitFeeBase), 0);
  const stale = legs.filter((l) => l.stale || l.rate == null).length;

  const actualStress = (stress.data?.legs ?? []).filter((l) => l.actual && !l.error);
  const worstCase = actualStress.reduce((s, l) => s + Math.min(0, l.report.worstCaseBase), 0);
  const worstLabels = actualStress.map((l) => `${l.pair} ${l.report.worstCaseLabel}`);

  const loading = quotes.isLoading || stress.isLoading;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Cash at risk — FX funding legs</CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px]">
              {legs.length} open leg{legs.length === 1 ? "" : "s"}
            </Badge>
            {stale > 0 && (
              <Badge variant="destructive" className="text-[10px]">
                {stale} stale rate{stale === 1 ? "" : "s"}
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading && <p className="text-xs text-muted-foreground">Marking legs to market…</p>}
        {!loading && legs.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No open FX legs — nothing at risk. The cards below still show the reference GBPUSD leg
            and the playbook evidence.
          </p>
        )}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Gross notional</p>
            <p className="text-lg font-semibold tabular-nums">{money(grossNotional, baseCcy, false)}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Close now (net)</p>
            <p
              className={`text-lg font-semibold tabular-nums ${
                closeNow < 0 ? "text-destructive" : "text-emerald-600 dark:text-emerald-400"
              }`}
            >
              {money(closeNow, baseCcy)}
            </p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Exit fees</p>
            <p className="text-lg font-semibold tabular-nums">{money(exitFees, baseCcy, false)}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Stress worst case</p>
            <p className="text-lg font-semibold tabular-nums text-destructive">
              {money(worstCase, baseCcy)}
            </p>
          </div>
        </div>
        <p className="text-[11px] leading-snug text-muted-foreground">
          Close-now is realised P&L after the estimated spot exit fee. Stress worst case sums the
          deepest modelled adverse scenario per open leg
          {worstLabels.length > 0 ? ` (${worstLabels.join(", ")})` : ""} — instant shocks, sigma
          gaps, vol spikes and the worst moves in 20 years of ECB closes. Tail events can exceed it.
        </p>
      </CardContent>
    </Card>
  );
}
