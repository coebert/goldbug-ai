import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PortfolioTabs } from "@/components/portfolio-detail/portfolio-tabs";
import { Metric } from "@/components/portfolio-detail/metric";
import { StalePriceWarning } from "@/components/stale-price-warning";
import { TradingPnlCharts } from "@/components/trading-pnl-charts";
import { HoldingPriceCharts } from "@/components/holding-price-charts";
import { OrderFillsCard } from "@/components/order-fills-card";
import { StrategyBuilderCard } from "@/components/strategy-builder-card";
import { getPortfolio } from "@/lib/portfolios.functions";
import { getHoldingsHistory } from "@/lib/holdings-history.functions";
import { getOrderFills } from "@/lib/order-fills.functions";
import { manualSellHolding } from "@/lib/manual-sell.functions";
import { derivePortfolioMetrics } from "@/lib/derive-portfolio-metrics";
import { holdingNativeValue } from "@/lib/fx-leg-value";

const TITLE = "Trading Desk — Aegis";
const DESC =
  "Live trading desk: open positions, pending broker orders, real fills with fees, and P&L, drawdown and risk charts.";

export const Route = createFileRoute("/portfolio/$id/trade")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESC },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESC },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: TradePage,
  errorComponent: ({ error, reset }) => (
    <div className="p-6 text-sm">
      <p className="text-destructive">{(error as Error).message}</p>
      <Button className="mt-3" onClick={reset}>
        Retry
      </Button>
    </div>
  ),
  notFoundComponent: () => <div className="p-6">Not found</div>,
});

const PENDING = new Set(["submitted", "pending", "working", "accepted", "queued", "partial"]);

function TradePage() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const get = useServerFn(getPortfolio);
  const getHistory = useServerFn(getHoldingsHistory);
  const fills = useServerFn(getOrderFills);
  const sell = useServerFn(manualSellHolding);

  const q = useQuery({
    queryKey: ["portfolio", "detail", id],
    queryFn: () => get({ data: { id } }),
    refetchInterval: 30_000,
  });
  const historyQ = useQuery({
    queryKey: ["holdings-history", id],
    queryFn: () => getHistory({ data: { portfolioId: id } }),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
  const ordersQ = useQuery({
    queryKey: ["order-fills", id],
    queryFn: () => fills({ data: { portfolioId: id, limit: 40 } }),
    refetchInterval: 15_000,
  });

  const p = q.data?.portfolio as
    | {
        name?: string;
        currency?: string | null;
        current_cash?: number | null;
        starting_cash?: number | null;
        mode?: string;
      }
    | undefined;
  const holdings = (q.data?.holdings ?? []) as Array<{
    id: string;
    symbol: string;
    quantity: number;
    avg_cost: number;
    asset_class?: string | null;
  }>;
  const equity = (q.data?.equity ?? []) as Array<{ snapshot_date: string; total_value: number }>;
  const latestSnapshot = equity.length ? (equity[equity.length - 1] as never) : null;

  const metrics = useMemo(
    () =>
      derivePortfolioMetrics({
        latestSnapshot,
        currentCash: p?.current_cash ?? 0,
        holdings,
      }),
    [latestSnapshot, p?.current_cash, holdings],
  );

  const ccy = (p?.currency ?? "GBP").toUpperCase();
  const fmt = (n: number, signed = false) =>
    new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: ccy,
      maximumFractionDigits: 2,
      signDisplay: signed ? "exceptZero" : "auto",
    }).format(n);

  const priceBySymbol = useMemo(() => {
    const m: Record<string, number | null> = {};
    for (const h of historyQ.data ?? []) m[h.symbol] = h.currentPrice;
    return m;
  }, [historyQ.data]);

  const positions = useMemo(
    () =>
      holdings
        .filter((h) => Number(h.quantity) !== 0)
        .map((h) => {
          const price = priceBySymbol[h.symbol] ?? null;
          const cost = holdingNativeValue({
            assetClass: h.asset_class ?? null,
            quantity: Number(h.quantity),
            price: Number(h.avg_cost),
            avgCost: Number(h.avg_cost),
          });
          const value =
            price == null
              ? cost
              : holdingNativeValue({
                  assetClass: h.asset_class ?? null,
                  quantity: Number(h.quantity),
                  price,
                  avgCost: Number(h.avg_cost),
                });
          return {
            id: h.id,
            symbol: h.symbol,
            quantity: Number(h.quantity),
            avgCost: Number(h.avg_cost),
            price,
            cost,
            value,
            pnl: price == null ? null : value - cost,
            pnlPct: price == null || cost === 0 ? null : ((value - cost) / Math.abs(cost)) * 100,
          };
        })
        .sort((a, b) => Math.abs(b.value) - Math.abs(a.value)),
    [holdings, priceBySymbol],
  );

  const unrealised = positions.reduce((s, l) => s + (l.pnl ?? 0), 0);
  const pending = (ordersQ.data?.rows ?? []).filter(
    (r) => PENDING.has(r.status.toLowerCase()) && r.filledQty < r.orderedQty,
  );
  const feesToday = (ordersQ.data?.rows ?? []).reduce((s, r) => s + r.fee, 0);
  const grossExposure = positions.reduce((s, l) => s + Math.abs(l.value), 0);
  const largest = positions[0];
  const concentration = grossExposure > 0 && largest ? (Math.abs(largest.value) / grossExposure) * 100 : 0;

  const sellMut = useMutation({
    mutationFn: (args: { holdingId: string; percent: number }) => sell({ data: args }),
    onSuccess: (r) => {
      toast.success(`Sell ${r.symbol}: ${r.status}`, {
        description: `${r.qty} @ ${r.price} ${r.instrument_ccy}`,
      });
      qc.invalidateQueries({ queryKey: ["portfolio", "detail", id] });
      qc.invalidateQueries({ queryKey: ["order-fills", id] });
      qc.invalidateQueries({ queryKey: ["holdings-history", id] });
    },
    onError: (e) => toast.error((e as Error).message || "Sell failed"),
    onSettled: () => setBusy(null),
  });

  const doSell = (holdingId: string, percent: number) => {
    setBusy(`${holdingId}:${percent}`);
    sellMut.mutate({ holdingId, percent });
  };

  return (
    <div className="min-h-dvh bg-background">
      <AppHeader />
      <main className="mx-auto max-w-7xl space-y-4 p-4 md:p-6">
        <PortfolioTabs id={id} />
        <Link
          to="/portfolio/$id"
          params={{ id }}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline"
        >
          <ArrowLeft className="h-3 w-3" /> Back to portfolio
        </Link>

        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold">{p?.name ?? "Portfolio"} — trading desk</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Open positions, working orders and the broker's own fills, with P&amp;L, drawdown and
              risk in one view. Sells route through the same broker pipeline the AI uses.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {p?.mode && (
              <Badge variant="outline" className="text-[10px] uppercase">
                {p.mode}
              </Badge>
            )}
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              onClick={() => {
                qc.invalidateQueries({ queryKey: ["portfolio", "detail", id] });
                qc.invalidateQueries({ queryKey: ["order-fills", id] });
                qc.invalidateQueries({ queryKey: ["holdings-history", id] });
              }}
            >
              <RefreshCw className="mr-1 h-3 w-3" /> Refresh
            </Button>
          </div>
        </div>

        <StalePriceWarning portfolioId={id} />

        <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
          <Metric label="Total value" value={fmt(metrics.totalValue)} />
          <Metric label="Cash" value={fmt(metrics.cash)} />
          <Metric label="Gross exposure" value={fmt(grossExposure)} hint={`${positions.length} positions`} />
          <Metric
            label="Unrealised P&L"
            value={fmt(unrealised, true)}
            tone={unrealised >= 0 ? "up" : "down"}
          />
          <Metric label="Working orders" value={String(pending.length)} hint="not yet fully filled" />
          <Metric
            label="Largest position"
            value={`${concentration.toFixed(0)}%`}
            hint={largest ? largest.symbol : "—"}
          />
        </div>

        <TradingPnlCharts
          equity={equity.map((e) => ({ date: e.snapshot_date, value: Number(e.total_value) }))}
          baseline={Number(p?.starting_cash ?? 0)}
          currency={ccy}
          positions={positions.map((l) => ({ symbol: l.symbol, value: l.value, pnl: l.pnl }))}
        />

        <HoldingPriceCharts
          series={(historyQ.data ?? []).map((s) => ({
            symbol: s.symbol,
            avg_cost: Number(s.avg_cost),
            quantity: Number(s.quantity),
            closes: s.closes ?? [],
            hourly: s.hourly ?? [],
            hourlyAt: s.hourlyAt ?? [],
            currentPrice: s.currentPrice,
            hourlyStale: Boolean(s.hourlyStale),
          }))}
          isLoading={historyQ.isLoading}
          updatedAt={historyQ.dataUpdatedAt}
        />

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Open positions</CardTitle>
          </CardHeader>
          <CardContent>
            {q.isLoading && <p className="text-xs text-muted-foreground">Loading positions…</p>}
            {!q.isLoading && positions.length === 0 && (
              <p className="text-xs text-muted-foreground">No open positions — everything is in cash.</p>
            )}
            {positions.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="py-1 pr-3">Symbol</th>
                      <th className="py-1 pr-3 text-right">Qty</th>
                      <th className="py-1 pr-3 text-right">Avg cost</th>
                      <th className="py-1 pr-3 text-right">Price</th>
                      <th className="py-1 pr-3 text-right">Value</th>
                      <th className="py-1 pr-3 text-right">Unrealised</th>
                      <th className="py-1 text-right">Trade</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((l) => (
                      <tr key={l.id} className="border-t border-border/60">
                        <td className="py-1.5 pr-3 font-medium">{l.symbol}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{l.quantity}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{fmt(l.avgCost)}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">
                          {l.price == null ? "—" : fmt(l.price)}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{fmt(l.value)}</td>
                        <td
                          className={`py-1.5 pr-3 text-right tabular-nums ${
                            (l.pnl ?? 0) < 0
                              ? "text-destructive"
                              : "text-emerald-600 dark:text-emerald-400"
                          }`}
                        >
                          {l.pnl == null
                            ? "—"
                            : `${fmt(l.pnl, true)} (${(l.pnlPct ?? 0).toFixed(1)}%)`}
                        </td>
                        <td className="py-1.5 text-right">
                          <div className="flex justify-end gap-1">
                            {[25, 50, 100].map((pct) => (
                              <Button
                                key={pct}
                                size="sm"
                                variant={pct === 100 ? "destructive" : "outline"}
                                className="h-7 px-2 text-[11px]"
                                disabled={sellMut.isPending}
                                onClick={() => doSell(l.id, pct)}
                              >
                                {busy === `${l.id}:${pct}` ? "…" : pct === 100 ? "Sell all" : `${pct}%`}
                              </Button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base">Pending orders ({pending.length})</CardTitle>
              <Badge variant="outline" className="text-[10px]">
                fees on shown orders {fmt(feesToday)}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-1 text-xs">
            {pending.length === 0 ? (
              <p className="text-muted-foreground">Nothing working at the broker.</p>
            ) : (
              pending.map((o) => (
                <div key={o.orderId} className="flex flex-wrap justify-between gap-2 border-b border-border/60 py-1">
                  <span className="font-medium">
                    {o.side.toUpperCase()} {o.symbol}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {o.filledQty}/{o.orderedQty} filled
                    {o.limitPrice != null && ` · limit ${o.limitPrice}`} · {o.status}
                    {o.submittedAt &&
                      ` · sent ${new Date(o.submittedAt).toLocaleTimeString("en-GB", { timeZone: "Europe/London" })}`}
                  </span>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <StrategyBuilderCard portfolioId={id} />

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Broker fills</CardTitle>
          </CardHeader>
          <CardContent>
            <OrderFillsCard portfolioId={id} />
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
