import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { RefreshCw, Scale } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { PageShell } from "@/components/layout/page-shell";
import { PortfolioTabs } from "@/components/portfolio-detail/portfolio-tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getDailyComparison, refreshSymbolStrengths } from "@/lib/daily-comparison.functions";

export const Route = createFileRoute("/portfolio/$id/daily-comparison")({
  component: DailyComparisonPage,
  head: () => ({
    meta: [
      { title: "Daily picks vs rules — with each name's track record" },
      {
        name: "description",
        content:
          "Today's AI picks beside the rule set's, ordered by how reliably each instrument's signal has predicted this account's own cost-adjusted results.",
      },
      { property: "og:title", content: "Daily picks vs rules, ranked by track record" },
      {
        property: "og:description",
        content:
          "Which names and sizes the AI and the rule set disagree on, and how strong each name's historical signal is.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

function pct(v: number | null | undefined, digits = 0): string {
  return v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(digits)}%`;
}

function strengthTone(label: string): "default" | "secondary" | "outline" {
  return label === "strong" ? "default" : label === "moderate" ? "secondary" : "outline";
}

function DailyComparisonPage() {
  const { id } = Route.useParams();
  const load = useServerFn(getDailyComparison);
  const refresh = useServerFn(refreshSymbolStrengths);
  const qc = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["daily-comparison", id],
    queryFn: () => load({ data: { portfolioId: id } }),
  });

  const rebuild = useMutation({
    mutationFn: () => refresh({ data: {} }),
    onSuccess: (res) =>
      setMessage(
        res.ok
          ? `Measured ${res.measured} instruments from ${res.from ?? "?"} to ${res.to ?? "?"}.`
          : (res as { error?: string }).error ?? "Could not measure the history.",
      ),
    onError: (e: unknown) => setMessage(e instanceof Error ? e.message : String(e)),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["daily-comparison", id] }),
  });

  const rows = data?.rows ?? [];
  const differing = rows.filter((r) => r.differs && (r.aiSide || r.ruleSide));

  return (
    <>
      <AppHeader />
      <PageShell
        title={
          <span className="flex items-center gap-2">
            <Scale className="h-6 w-6 text-primary" aria-hidden />
            Today's picks vs the rules
          </span>
        }
        purpose="Every name the AI looked at today, side by side with what the fixed rule set would have done — ordered by how well that name's signals have actually predicted this account's results after costs, so the strongest evidence sits at the top."
        actions={
          <Button onClick={() => rebuild.mutate()} disabled={rebuild.isPending}>
            <RefreshCw
              className={`mr-2 h-4 w-4 ${rebuild.isPending ? "animate-spin" : ""}`}
              aria-hidden
            />
            {rebuild.isPending ? "Measuring history…" : "Re-measure track records"}
          </Button>
        }
      >
        <PortfolioTabs id={id} />

        {message ? <p className="mb-4 text-sm text-muted-foreground">{message}</p> : null}

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !data?.ok ? (
          <Card>
            <CardHeader>
              <CardTitle>Nothing to compare yet</CardTitle>
              <CardDescription>
                {data?.error ?? "Run the portfolio once and today's picks will appear here."}
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <div className="space-y-6">
            {(data.markets ?? []).some((mk) => mk.samples > 0) ? (
              <Card>
                <CardHeader>
                  <CardTitle>Signal strength by market and time of day</CardTitle>
                  <CardDescription>
                    How reliably each market's signals have predicted your results — all day, and
                    in the part of the day the latest review ran
                    {data.markets?.[0]?.sessionLabel ? ` (${data.markets[0].sessionLabel}, London time)` : ""}.
                    The AI scales each market's scores by the weight shown.
                  </CardDescription>
                </CardHeader>
                <CardContent className="overflow-x-auto">
                  <table className="w-full min-w-[40rem] text-sm">
                    <thead className="text-left text-xs uppercase text-muted-foreground">
                      <tr>
                        <th className="py-2 pr-3">Market</th>
                        <th className="py-2 pr-3">All day</th>
                        <th className="py-2 pr-3">Right</th>
                        <th className="py-2 pr-3">Avg result</th>
                        <th className="py-2 pr-3">This session</th>
                        <th className="py-2 pr-3">Score weight</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(data.markets ?? []).map((mk) => (
                        <tr key={mk.market} className="border-t border-border">
                          <td className="py-2 pr-3 font-medium">{mk.marketLabel}</td>
                          <td className="py-2 pr-3">
                            {mk.samples > 0 ? (
                              <>
                                <Badge variant={strengthTone(mk.strengthLabel)} className="capitalize">
                                  {mk.strengthLabel}
                                </Badge>
                                <div className="mt-1 text-xs text-muted-foreground">
                                  {mk.samples} observations
                                </div>
                              </>
                            ) : (
                              <span className="text-muted-foreground">not measured yet</span>
                            )}
                          </td>
                          <td className="py-2 pr-3">{pct(mk.hitRate)}</td>
                          <td className="py-2 pr-3">
                            {mk.meanNetBps == null
                              ? "—"
                              : `${mk.meanNetBps >= 0 ? "+" : ""}${(mk.meanNetBps / 100).toFixed(2)}%`}
                          </td>
                          <td className="py-2 pr-3">
                            {mk.sessionStrengthLabel && mk.sessionStrength != null ? (
                              <>
                                <Badge
                                  variant={strengthTone(mk.sessionStrengthLabel)}
                                  className="capitalize"
                                >
                                  {mk.sessionStrengthLabel}
                                </Badge>
                                <div className="mt-1 text-xs text-muted-foreground">
                                  {mk.sessionSamples} observations
                                </div>
                              </>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="py-2 pr-3">×{mk.weight.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            ) : null}
            <Card>
              <CardHeader>
                <CardTitle>
                  {differing.length} name{differing.length === 1 ? "" : "s"} where the AI and the
                  rules disagree
                </CardTitle>
                <CardDescription>
                  Snapshot from {data.asOf ?? "the latest run"}. Track records measured over{" "}
                  {data.horizonDays} trading days on {data.strengthsMeasured} instruments
                  {data.strengthsMeasured === 0
                    ? " — press “Re-measure track records” to build them from your history."
                    : "."}
                </CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full min-w-[52rem] text-sm">
                  <thead className="text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-3">Instrument</th>
                      <th className="py-2 pr-3">Track record</th>
                      <th className="py-2 pr-3">Right</th>
                      <th className="py-2 pr-3">Avg result</th>
                      <th className="py-2 pr-3">Model rank</th>
                      <th className="py-2 pr-3">AI today</th>
                      <th className="py-2 pr-3">Rules today</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr
                        key={r.symbol}
                        className={`border-t border-border ${r.differs && (r.aiSide || r.ruleSide) ? "bg-muted/40" : ""}`}
                      >
                        <td className="py-2 pr-3">
                          <div className="font-medium">{r.symbol}</div>
                          <div className="text-xs text-muted-foreground">{r.name}</div>
                        </td>
                        <td className="py-2 pr-3">
                          <Badge variant={strengthTone(r.strengthLabel)} className="capitalize">
                            {r.strengthLabel}
                          </Badge>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {r.strengthMeasured
                              ? `${r.samples} observations${r.from ? ` since ${r.from}` : ""}`
                              : "not measured yet"}
                          </div>
                        </td>
                        <td className="py-2 pr-3">{pct(r.hitRate)}</td>
                        <td className="py-2 pr-3">
                          {r.meanNetBps == null
                            ? "—"
                            : `${r.meanNetBps >= 0 ? "+" : ""}${(r.meanNetBps / 100).toFixed(2)}%`}
                        </td>
                        <td className="py-2 pr-3">
                          {r.modelRank == null ? "—" : `#${r.modelRank}`}
                        </td>
                        <td className="py-2 pr-3">
                          {r.aiSide ? (
                            <span className="capitalize">
                              {r.aiSide}
                              {r.aiSize == null ? "" : ` £${Math.round(r.aiSize).toLocaleString()}`}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">no action</span>
                          )}
                        </td>
                        <td className="py-2 pr-3">
                          {r.ruleSide ? (
                            <span className="capitalize">
                              {r.ruleSide}
                              {r.rulePercent == null ? "" : ` ${r.rulePercent}% of cash`}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">no action</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </div>
        )}
      </PageShell>
    </>
  );
}
