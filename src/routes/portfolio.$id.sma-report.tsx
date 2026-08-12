import { createFileRoute, Link } from "@tanstack/react-router";
import { PortfolioTabs } from "@/components/portfolio-detail/portfolio-tabs";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getSmaSymbolReport } from "@/lib/sma-timeline.functions";
import { AppHeader } from "@/components/app-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, TrendingUp, TrendingDown } from "lucide-react";
import {
  ComposedChart,
  Line,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceArea,
  ResponsiveContainer,
} from "recharts";
import {
  AXIS_LINE,
  AXIS_TICK,
  CHART_NEUTRAL_SERIES,
  CHART_ROLE,
  GRID_PROPS,
  LEGEND_STYLE,
  OKABE_ITO,
  TICK_LINE,
  TOOLTIP_CONTENT_STYLE,
  TOOLTIP_ITEM_STYLE,
  TOOLTIP_LABEL_STYLE,
} from "@/lib/chart-palette";

export const Route = createFileRoute("/portfolio/$id/sma-report")({
  head: () => ({
    meta: [
      { title: "SMA Crossover Report — Aegis" },
      {
        name: "description",
        content:
          "Per-symbol SMA20/50 crossover points, the SMA50/200 golden and death cross regime, and every buy and sell the AI took against that trend.",
      },
      { property: "og:title", content: "SMA Crossover Report — Aegis" },
      {
        property: "og:description",
        content:
          "See where the trend turned for each symbol and exactly which trades were taken with or against it.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: SmaReportPage,
  errorComponent: ({ error, reset }) => (
    <div className="p-6 text-sm">
      <p className="text-destructive">{(error as Error).message}</p>
      <Button className="mt-3" onClick={reset}>
        Retry
      </Button>
    </div>
  ),
});

const pct = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
const num = (v: number | null | undefined, dp = 2) =>
  v == null || !Number.isFinite(v) ? "—" : v.toFixed(dp);

function SmaReportPage() {
  const { id } = Route.useParams();
  const fetchReport = useServerFn(getSmaSymbolReport);
  const [symbol, setSymbol] = useState<string | undefined>(undefined);

  const { data, isLoading } = useQuery({
    queryKey: ["sma-report", id, symbol ?? "auto"],
    queryFn: () => fetchReport({ data: { portfolioId: id, ...(symbol ? { symbol } : {}) } }),
  });

  const report = data?.report ?? null;
  const symbols = data?.symbols ?? [];

  // Chart only needs the SMA200 era onwards — before that there is no regime
  // to show and the warm-up flat-lines the series.
  const chartData = useMemo(() => {
    if (!report) return [];
    const bars = report.bars.slice(-500);
    const buys = new Map(report.decisions.filter((d) => d.side === "buy").map((d) => [d.date, d.close]));
    const sells = new Map(report.decisions.filter((d) => d.side === "sell").map((d) => [d.date, d.close]));
    return bars.map((b) => ({
      ...b,
      buy: buys.get(b.date) ?? null,
      sell: sells.get(b.date) ?? null,
    }));
  }, [report]);

  const shading = useMemo(() => {
    if (!report || chartData.length === 0) return [];
    const first = chartData[0]!.date;
    return report.regimes
      .filter((s) => s.regime !== "unknown" && s.endDate >= first)
      .map((s) => ({ ...s, startDate: s.startDate < first ? first : s.startDate }));
  }, [report, chartData]);

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />
      <main className="mx-auto max-w-6xl 2xl:max-w-7xl space-y-4 p-4 sm:p-6">
        <PortfolioTabs id={id} />
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="sm">
            <Link to="/portfolio/$id" params={{ id }}>
              <ArrowLeft className="mr-1 h-4 w-4" /> Back
            </Link>
          </Button>
          <h1 className="text-xl font-semibold">SMA crossover report</h1>
        </div>

        <div className="flex flex-wrap gap-2">
          {symbols.map((s) => (
            <Button
              key={s}
              size="sm"
              variant={s === report?.symbol ? "default" : "outline"}
              onClick={() => setSymbol(s)}
            >
              {s}
            </Button>
          ))}
        </div>

        {isLoading && <p className="text-sm text-muted-foreground">Loading price history…</p>}
        {!isLoading && !report && (
          <p className="text-sm text-muted-foreground">
            No traded or held symbols yet for this portfolio.
          </p>
        )}

        {report && (
          <>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                  {report.symbol}
                  <Badge variant={report.summary.currentRegime === "golden" ? "default" : "secondary"}>
                    {report.summary.currentRegime === "golden"
                      ? "Golden regime (SMA50 above SMA200)"
                      : report.summary.currentRegime === "death"
                        ? "Death regime (SMA50 below SMA200)"
                        : "Regime unknown — short history"}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                  <Stat label="Bars analysed" value={String(report.summary.barCount)} />
                  <Stat
                    label="Confirmed SMA20/50 crosses"
                    value={`${report.summary.confirmedFastCrosses} (${report.summary.whipsawFastCrosses} whipsaws ignored)`}
                  />
                  <Stat
                    label="Golden / death crosses"
                    value={`${report.summary.goldenCrosses} / ${report.summary.deathCrosses}`}
                  />
                  <Stat
                    label="Trades with the trend"
                    value={
                      report.summary.withTrendPct == null
                        ? "—"
                        : `${(report.summary.withTrendPct * 100).toFixed(0)}% of ${report.summary.buys + report.summary.sells}`
                    }
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Median move after a confirmed bull cross {pct(report.summary.medianBullForwardPct)}; after
                  a bear cross {pct(report.summary.medianBearForwardPct)}. Measured to the next crossover.
                </p>
                {report.summary.warnings.length > 0 && (
                  <p className="text-xs text-muted-foreground">{report.summary.warnings.join(" · ")}</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Price, moving averages and trades</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-[360px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 24, left: 8 }}>
                      <CartesianGrid {...GRID_PROPS} />
                      {shading.map((s) => (
                        <ReferenceArea
                          key={`${s.regime}-${s.startDate}`}
                          x1={s.startDate}
                          x2={s.endDate}
                          fill={s.regime === "golden" ? CHART_ROLE.positive : CHART_ROLE.negative}
                          fillOpacity={0.07}
                          strokeOpacity={0}
                        />
                      ))}
                      <XAxis
                        dataKey="date"
                        tick={AXIS_TICK}
                        axisLine={AXIS_LINE}
                        tickLine={TICK_LINE}
                        minTickGap={48}
                        label={{ value: "Date", position: "insideBottom", offset: -12, fontSize: 12, fill: "var(--foreground)" }}
                      />
                      <YAxis
                        tick={AXIS_TICK}
                        axisLine={AXIS_LINE}
                        tickLine={TICK_LINE}
                        domain={["auto", "auto"]}
                        width={64}
                        label={{ value: "Price", angle: -90, position: "insideLeft", fontSize: 12, fill: "var(--foreground)" }}
                      />
                      <Tooltip
                        formatter={(v: unknown, name) => [num(Number(v)), String(name)]}
                        contentStyle={TOOLTIP_CONTENT_STYLE}
                        labelStyle={TOOLTIP_LABEL_STYLE}
                        itemStyle={TOOLTIP_ITEM_STYLE}
                      />
                      <Legend wrapperStyle={LEGEND_STYLE} />
                      <Line
                        type="monotone"
                        dataKey="close"
                        name="Close"
                        stroke={CHART_NEUTRAL_SERIES}
                        dot={false}
                        strokeWidth={1.5}
                      />
                      <Line type="monotone" dataKey="sma20" name="SMA20" stroke={OKABE_ITO.skyBlue} dot={false} strokeWidth={1.5} />
                      <Line type="monotone" dataKey="sma50" name="SMA50" stroke={OKABE_ITO.orange} dot={false} strokeWidth={1.5} />
                      <Line type="monotone" dataKey="sma200" name="SMA200" stroke={OKABE_ITO.bluishGreen} dot={false} strokeWidth={1.5} />
                      <Scatter dataKey="buy" name="Buy" fill={CHART_ROLE.positive} shape="triangle" />
                      <Scatter dataKey="sell" name="Sell" fill={CHART_ROLE.negative} shape="triangle" />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Green shading marks a golden regime (SMA50 above SMA200), red a death regime. Triangles
                  are executed trades.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Crossover points</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-3">Date</th>
                      <th className="py-1 pr-3">Cross</th>
                      <th className="py-1 pr-3">Separation</th>
                      <th className="py-1 pr-3">Confirmed</th>
                      <th className="py-1 pr-3">Held</th>
                      <th className="py-1 pr-3">Move to next cross</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.crosses.slice(-40).reverse().map((c) => (
                      <tr key={`${c.kind}-${c.date}`} className="border-t border-border">
                        <td className="py-1 pr-3">{c.date}</td>
                        <td className="py-1 pr-3">
                          <span className="inline-flex items-center gap-1">
                            {c.direction === "bull" || c.direction === "golden" ? (
                              <TrendingUp className="h-3 w-3 text-[var(--chart-positive,currentColor)]" />
                            ) : (
                              <TrendingDown className="h-3 w-3" />
                            )}
                            {c.kind === "fast" ? "SMA20/50 " : "SMA50/200 "}
                            {c.direction}
                          </span>
                        </td>
                        <td className="py-1 pr-3">{pct(c.separationPct)}</td>
                        <td className="py-1 pr-3">
                          {c.whipsaw ? (
                            <Badge variant="outline">whipsaw — ignored</Badge>
                          ) : (
                            c.confirmedDate
                          )}
                        </td>
                        <td className="py-1 pr-3">{c.heldBars == null ? "live" : `${c.heldBars} bars`}</td>
                        <td className="py-1 pr-3">{pct(c.forwardReturnPct)}</td>
                      </tr>
                    ))}
                    {report.crosses.length === 0 && (
                      <tr>
                        <td className="py-2 text-muted-foreground" colSpan={6}>
                          No crossovers in the available history.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Regime timeline</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-3">Regime</th>
                      <th className="py-1 pr-3">From</th>
                      <th className="py-1 pr-3">To</th>
                      <th className="py-1 pr-3">Bars</th>
                      <th className="py-1 pr-3">Price move</th>
                      <th className="py-1 pr-3">Buys / sells</th>
                      <th className="py-1 pr-3">Net traded</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.regimes.slice().reverse().map((s) => (
                      <tr key={s.startDate} className="border-t border-border">
                        <td className="py-1 pr-3 capitalize">{s.regime}</td>
                        <td className="py-1 pr-3">{s.startDate}</td>
                        <td className="py-1 pr-3">{s.endDate}</td>
                        <td className="py-1 pr-3">{s.bars}</td>
                        <td className="py-1 pr-3">{pct(s.returnPct)}</td>
                        <td className="py-1 pr-3">
                          {s.buys} / {s.sells}
                        </td>
                        <td className="py-1 pr-3">{num(s.netValue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Decisions taken</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {report.decisions.length === 0 && (
                  <p className="text-sm text-muted-foreground">No trades recorded for {report.symbol}.</p>
                )}
                {report.decisions
                  .slice()
                  .reverse()
                  .map((d, i) => (
                    <div key={`${d.date}-${i}`} className="rounded-md border border-border p-3 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={d.side === "buy" ? "default" : "secondary"}>
                          {d.side.toUpperCase()}
                        </Badge>
                        <span className="font-medium">{d.date}</span>
                        <span className="text-muted-foreground">
                          {num(d.quantity, 4)} @ {num(d.price)}
                        </span>
                        <Badge
                          variant={d.alignment === "against_trend" ? "destructive" : "outline"}
                          className="capitalize"
                        >
                          {d.alignment.replace("_", " ")}
                        </Badge>
                      </div>
                      <p className="mt-1 text-muted-foreground">{d.note}</p>
                      <p className="mt-1 text-muted-foreground">
                        Close {num(d.close)} · SMA20 {num(d.sma20)} · SMA50 {num(d.sma50)} · SMA200{" "}
                        {num(d.sma200)} · fast spread {pct(d.fastSpreadPct)} · regime spread{" "}
                        {pct(d.regimeSpreadPct)}
                      </p>
                      {d.reason && <p className="mt-1 italic text-muted-foreground">“{d.reason}”</p>}
                    </div>
                  ))}
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  );
}
