import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { AppHeader } from "@/components/app-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getSymbolDesk } from "@/lib/symbol-desk.functions";

export const Route = createFileRoute("/symbols/")({
  head: () => ({
    meta: [
      { title: "Symbols — Signal Strength & Risk Limits | Aegis" },
      {
        name: "description",
        content:
          "Every instrument the engine follows: measured signal strength, dealing cost, live price levels and the per-symbol risk limits you can adjust.",
      },
      { property: "og:title", content: "Symbols — Signal Strength & Risk Limits | Aegis" },
      {
        property: "og:description",
        content: "Per-symbol track record, price levels and hand-set trading limits.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: SymbolsPage,
});

function pct(v: number | null | undefined, digits = 1): string {
  return v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(digits)}%`;
}

function strengthTone(v: number | null): string {
  if (v == null) return "text-muted-foreground";
  if (v >= 0.6) return "text-emerald-500";
  if (v >= 0.3) return "text-amber-500";
  return "text-muted-foreground";
}

function SymbolsPage() {
  const load = useServerFn(getSymbolDesk);
  const { data, isLoading, error } = useQuery({
    queryKey: ["symbol-desk"],
    queryFn: () => load({ data: {} }),
    staleTime: 60_000,
  });

  return (
    <div className="min-h-screen overflow-x-hidden bg-background">
      <AppHeader />
      <main className="mx-auto w-full min-w-0 max-w-5xl space-y-4 p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-foreground">Symbols</h1>
            <p className="text-sm text-muted-foreground">
              What each name has actually been worth to this account, what it costs to trade, and
              the limits in force. Tap a symbol to change its limits.
            </p>
          </div>
          <Link to="/markets" className="text-sm text-muted-foreground hover:text-foreground">
            Markets →
          </Link>
        </div>

        {isLoading ? (
          <Card>
            <CardContent className="space-y-2 p-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </CardContent>
          </Card>
        ) : error ? (
          <Card>
            <CardContent className="p-4 text-sm text-destructive">
              Could not load your symbols right now.
            </CardContent>
          </Card>
        ) : !data ? (
          <Card>
            <CardContent className="p-4 text-sm text-muted-foreground">
              No portfolio to read yet.
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                {data.portfolioName}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  default cap {pct(data.base.maxPositionPct, 0)} · stop{" "}
                  {pct(data.base.stopLossPct, 0)} · target {pct(data.base.takeProfitPct, 0)}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="w-full overflow-x-auto">
                <table className="w-full min-w-[46rem] text-sm">
                  <thead className="text-xs uppercase text-muted-foreground">
                    <tr className="border-b border-border">
                      <th className="px-3 py-2 text-left font-medium">Symbol</th>
                      <th className="px-3 py-2 text-right font-medium">Signal strength</th>
                      <th className="px-3 py-2 text-right font-medium">Round trip</th>
                      <th className="px-3 py-2 text-right font-medium">Last price</th>
                      <th className="px-3 py-2 text-right font-medium">Held</th>
                      <th className="px-3 py-2 text-right font-medium">Limits</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <tr key={r.key} className="border-b border-border/60 last:border-0">
                        <td className="px-3 py-2">
                          <Link
                            to="/symbols/$symbol"
                            params={{ symbol: r.key }}
                            className="font-medium text-foreground hover:underline"
                          >
                            {r.symbol}
                          </Link>
                          {r.limits.paused ? (
                            <Badge variant="destructive" className="ml-2 align-middle text-[10px]">
                              paused
                            </Badge>
                          ) : null}
                        </td>
                        <td className={`px-3 py-2 text-right tabular-nums ${strengthTone(r.strength)}`}>
                          {r.strength == null ? "not measured" : pct(r.strength, 0)}
                          <span className="ml-1 text-xs text-muted-foreground">
                            {r.samples ? `(${r.samples})` : ""}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {r.roundTripBps == null ? "—" : `${r.roundTripBps.toFixed(0)}bps`}
                          {r.costMeasured ? "" : r.roundTripBps == null ? "" : "*"}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {r.lastPrice == null ? "—" : r.lastPrice.toFixed(2)}
                          {r.changePct == null ? null : (
                            <span
                              className={`ml-1 text-xs ${r.changePct >= 0 ? "text-emerald-500" : "text-destructive"}`}
                            >
                              {pct(r.changePct, 1)}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {r.held ? `${r.quantity} · ${pct(r.exposurePct, 1)}` : "—"}
                        </td>
                        <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                          cap {pct(r.limits.maxPositionPct, 0)} · stop {pct(r.limits.stopLossPct, 0)}
                          {r.limits.overridden.length ? (
                            <Badge variant="secondary" className="ml-2 text-[10px]">
                              mine
                            </Badge>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                    {data.rows.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                          No symbols yet.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        <p className="text-xs text-muted-foreground">
          Signal strength is how well this account's own history predicted the following days for
          that name, shrunk for thin evidence. * marks a dealing cost still modelled rather than
          measured from real fills.
        </p>
      </main>
    </div>
  );
}
