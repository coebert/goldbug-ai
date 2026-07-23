import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getPortfolioStress } from "@/lib/insights.functions";
import { ShieldAlert } from "lucide-react";
import { Explain } from "@/components/explain";

export function StressPanelCard({ portfolioId, currency }: { portfolioId: string; currency: string }) {
  const fetchFn = useServerFn(getPortfolioStress);
  const { data, isLoading } = useQuery({
    queryKey: ["portfolio-stress", portfolioId],
    queryFn: () => fetchFn({ data: { portfolioId } }),
    staleTime: 5 * 60_000,
  });

  const fmt = (n: number) => `${n >= 0 ? "" : "-"}${currency} ${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  const pct = (n: number | null | undefined) => (n == null ? "—" : `${(n * 100).toFixed(2)}%`);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert className="h-4 w-4" /> Value-at-Risk & stress
          <Explain term="drawdown">?</Explain>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <p className="text-sm text-muted-foreground">Computing…</p>}
        {!isLoading && data && (
          <>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">1-day VaR (95%)</div>
                <div className="text-lg font-semibold">{pct(data.var95_pct)}</div>
                <div className="text-xs text-muted-foreground">{data.var95_value == null ? "—" : fmt(data.var95_value)}</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">Expected shortfall (CVaR)</div>
                <div className="text-lg font-semibold">{pct(data.cvar95_pct)}</div>
                <div className="text-xs text-muted-foreground">Avg loss in worst 5% of days · {data.n_days}d window</div>
              </div>
            </div>

            <div>
              <div className="text-xs font-medium text-muted-foreground mb-2">Scenario shocks</div>
              <div className="space-y-2">
                {data.scenarios.map((s) => (
                  <div key={s.name} className="flex items-center justify-between text-sm">
                    <span>{s.name}</span>
                    <span className={s.impact_pct < 0 ? "text-red-500" : "text-emerald-500"}>
                      {(s.impact_pct * 100).toFixed(2)}% · {fmt(s.impact_value)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {data.weights.length > 0 && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">Exposure by holding</div>
                <div className="flex flex-wrap gap-1">
                  {data.weights.map((w) => (
                    <span key={w.symbol} className="rounded bg-muted px-2 py-0.5 text-xs">
                      {w.symbol} {(w.weight_pct * 100).toFixed(0)}%
                    </span>
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
