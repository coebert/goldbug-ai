import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getFxStressReport, type FxStressLegReport } from "@/lib/fx-stress-report.functions";

function money(n: number, ccy: string) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: ccy,
    maximumFractionDigits: 0,
    signDisplay: "exceptZero",
  }).format(n);
}

const BASIS_LABEL: Record<string, string> = {
  "fixed-shock": "Shock",
  "gap-sigma": "Gap",
  "vol-spike": "Vol spike",
  "historical-worst": "Historic",
};

function LegTable({ leg, baseCcy }: { leg: FxStressLegReport; baseCcy: string }) {
  if (leg.error) {
    return <p className="text-xs text-muted-foreground">{leg.symbol}: {leg.error}</p>;
  }
  const r = leg.report;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{leg.pair}</span>
        <Badge variant={r.side === "short" ? "destructive" : "secondary"} className="text-[10px]">
          {r.side} {leg.quoteCcy} {Math.abs(r.notionalQuote).toLocaleString("en-GB", { maximumFractionDigits: 0 })}
        </Badge>
        {!leg.actual && (
          <Badge variant="outline" className="text-[10px]">reference</Badge>
        )}
        {r.sigmaDaily != null && (
          <span className="text-[11px] text-muted-foreground">
            σ daily {(r.sigmaDaily * 100).toFixed(2)}%
          </span>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground">
          worst case: <span className="font-medium text-destructive">{money(r.worstCaseBase, baseCcy)}</span> ({r.worstCaseLabel})
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 pr-2 font-medium">Scenario</th>
              <th className="py-1 pr-2 font-medium">Type</th>
              <th className="py-1 pr-2 text-right font-medium">Rate</th>
              <th className="py-1 pr-2 text-right font-medium">P&L ({baseCcy})</th>
            </tr>
          </thead>
          <tbody>
            {r.scenarios.map((s) => (
              <tr key={s.key} className="border-t border-border/50">
                <td className="py-1 pr-2">{s.label}</td>
                <td className="py-1 pr-2 text-muted-foreground">{BASIS_LABEL[s.basis] ?? s.basis}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{s.shockedRate.toFixed(4)}</td>
                <td
                  className={`py-1 pr-2 text-right tabular-nums ${
                    s.pnlBaseNet < 0 ? "text-destructive" : "text-emerald-600 dark:text-emerald-400"
                  }`}
                >
                  {money(s.pnlBaseNet, baseCcy)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Worst-case scenario report for open FX legs: instant rate shocks, sigma-
 * scaled overnight gaps, 2× vol-spike drifts and the worst moves observed in
 * ~20 years of ECB closes — all valued net of the spot exit fee. Goes beyond
 * the playbook backtest, which only sees realised tape.
 */
export function FxStressReportCard({
  portfolioId,
  active,
  pairFilter,
}: {
  portfolioId: string;
  active?: boolean;
  /** Show only this pair (e.g. "GBPUSD"); undefined shows every leg. */
  pairFilter?: string;
}) {
  const fn = useServerFn(getFxStressReport);
  const q = useQuery({
    queryKey: ["fx-stress-report", portfolioId, pairFilter ?? "all"],
    queryFn: () =>
      fn({
        data: {
          portfolioId,
          years: 20,
          // Stress the picked pair even with no open exposure in it.
          referencePairs: pairFilter ? [pairFilter.toUpperCase()] : ["GBPUSD"],
        },
      }),
    staleTime: 30 * 60_000,
    enabled: active !== false,
  });
  const shownLegs = (q.data?.legs ?? []).filter(
    (l) => !pairFilter || l.pair.toUpperCase() === pairFilter.toUpperCase(),
  );


  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">FX stress test — worst-case scenarios</CardTitle>
          {q.data && (
            <span className="text-[11px] text-muted-foreground">
              {q.data.years}y history · net of exit fees
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {q.isLoading && <p className="text-xs text-muted-foreground">Computing shock scenarios…</p>}
        {q.isError && (
          <p className="text-xs text-muted-foreground">Stress report unavailable right now.</p>
        )}
        {q.data &&
          shownLegs.map((leg) => (
            <LegTable key={leg.symbol} leg={leg} baseCcy={q.data.baseCcy} />
          ))}
        {q.data && shownLegs.length === 0 && (
          <p className="text-xs text-muted-foreground">No FX legs to stress.</p>
        )}

        <p className="text-[11px] leading-snug text-muted-foreground">
          Scenarios apply the move instantly to the current rate and value the leg at close, net of
          the estimated exit fee. Gaps use the historical daily-move distribution; historical-worst
          replays the deepest 1-day/1-week/1-month adverse moves since 2006. Tail events can still
          exceed every row here.
        </p>
      </CardContent>
    </Card>
  );
}
