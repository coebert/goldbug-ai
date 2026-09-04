import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PortfolioTabs } from "@/components/portfolio-detail/portfolio-tabs";
import { Metric } from "@/components/portfolio-detail/metric";
import { FxCashAtRiskCard } from "@/components/fx-cash-at-risk-card";
import { FxLegHistoryCard } from "@/components/fx-leg-history-card";
import { FxRiskAlertCard } from "@/components/fx-risk-alert-card";

import { FxLegRowsCard } from "@/components/fx-leg-rows-card";
import { FxLeverageLadderCard } from "@/components/fx-leverage-ladder-card";
import { getPortfolio } from "@/lib/portfolios.functions";
import { getHoldingsHistory } from "@/lib/holdings-history.functions";
import { derivePortfolioMetrics } from "@/lib/derive-portfolio-metrics";
import { readWallet } from "@/lib/portfolio-wallet";
import { holdingNativeValue } from "@/lib/fx-leg-value";

const TITLE = "Portfolio Summary — Aegis";
const DESC =
  "One-glance view of total cash, open positions, unrealised P&L and FX funding-leg risk for a portfolio.";

export const Route = createFileRoute("/portfolio/$id/summary")({
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
  component: SummaryPage,
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

function SummaryPage() {
  const { id } = Route.useParams();
  const [pair, setPair] = useState<string | undefined>(undefined);

  const get = useServerFn(getPortfolio);
  const q = useQuery({
    queryKey: ["portfolio", "detail", id],
    queryFn: () => get({ data: { id } }),
    refetchInterval: 60_000,
  });
  const getHistory = useServerFn(getHoldingsHistory);
  const historyQ = useQuery({
    queryKey: ["holdings-history", id],
    queryFn: () => getHistory({ data: { portfolioId: id } }),
    staleTime: 5 * 60_000,
  });

  const p = q.data?.portfolio as
    | { name?: string; currency?: string | null; current_cash?: number | null; starting_cash?: number | null; cash_by_ccy?: Record<string, number> | null; mode?: string }
    | undefined;
  const holdings = (q.data?.holdings ?? []) as Array<{
    symbol: string;
    quantity: number;
    avg_cost: number;
    asset_class?: string | null;
  }>;
  const equity = q.data?.equity ?? [];
  const latestSnapshot = equity.length ? (equity[equity.length - 1] as never) : null;

  // Exactly the same derivation the "My Portfolio" overview uses, so the
  // headline tiles here can never disagree with that page.
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
  const wallet = useMemo(
    () => readWallet({ currency: ccy, current_cash: p?.current_cash ?? 0, cash_by_ccy: p?.cash_by_ccy ?? null }),
    [ccy, p?.current_cash, p?.cash_by_ccy],
  );

  const priceBySymbol = useMemo(() => {
    const m: Record<string, number | null> = {};
    for (const h of historyQ.data ?? []) m[h.symbol] = h.currentPrice;
    return m;
  }, [historyQ.data]);

  const legs = useMemo(
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
              ? null
              : holdingNativeValue({
                  assetClass: h.asset_class ?? null,
                  quantity: Number(h.quantity),
                  price,
                  avgCost: Number(h.avg_cost),
                });
          return {
            symbol: h.symbol,
            quantity: Number(h.quantity),
            avgCost: Number(h.avg_cost),
            price,
            cost,
            value,
            pnl: value == null ? null : value - cost,
          };
        })
        .sort((a, b) => Math.abs(b.value ?? b.cost) - Math.abs(a.value ?? a.cost)),
    [holdings, priceBySymbol],
  );

  const unrealised = legs.reduce((s, l) => s + (l.pnl ?? 0), 0);
  const startingCash = Number(p?.starting_cash ?? 0);
  const pnl = metrics.totalValue - startingCash;
  const pnlPct = startingCash > 0 ? (pnl / startingCash) * 100 : 0;

  const fmt = (n: number, signed = false) =>
    new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: ccy,
      maximumFractionDigits: 2,
      signDisplay: signed ? "exceptZero" : "auto",
    }).format(n);

  return (
    <div className="min-h-dvh bg-background">
      <AppHeader />
      <main className="mx-auto max-w-7xl space-y-4 p-4 md:p-6">
        <PortfolioTabs id={id} />
        <Link
          to="/portfolio/$id/"
          params={{ id }}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline"
        >
          <ArrowLeft className="h-3 w-3" /> Back to portfolio
        </Link>
        <div>
          <h1 className="text-xl font-semibold">{p?.name ?? "Portfolio"} — summary</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Real cash, open positions and currency risk in one read. The headline numbers come from
            the same authoritative snapshot the overview page uses.
          </p>
        </div>

        <FxRiskAlertCard portfolioId={id} cashBase={metrics.cash} />


        <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
          <Metric label="Total value" value={fmt(metrics.totalValue)} hint={metrics.source === "snapshot" ? "from latest snapshot" : "no snapshot yet"} />
          <Metric label="Cash" value={fmt(metrics.cash)} hint={`${legs.length} open position${legs.length === 1 ? "" : "s"}`} />
          <Metric label="Invested" value={fmt(metrics.invested)} />
          <Metric
            label="Unrealised P&L"
            value={fmt(unrealised, true)}
            tone={unrealised >= 0 ? "up" : "down"}
            hint="marked at latest close"
          />
          <Metric
            label="Since inception"
            value={`${fmt(pnl, true)} (${pnlPct >= 0 ? "+" : "−"}${Math.abs(pnlPct).toFixed(2)}%)`}
            tone={pnl >= 0 ? "up" : "down"}
          />
        </div>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base">Cash by currency</CardTitle>
              <Badge variant="outline" className="text-[10px]">base {ccy}</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-4">
              {Object.entries(wallet).map(([k, v]) => (
                <div key={k}>
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{k}</p>
                  <p className="text-base font-semibold tabular-nums">
                    {new Intl.NumberFormat("en-GB", { style: "currency", currency: k, maximumFractionDigits: 2 }).format(v)}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Open positions</CardTitle>
          </CardHeader>
          <CardContent>
            {q.isLoading && <p className="text-xs text-muted-foreground">Loading positions…</p>}
            {!q.isLoading && legs.length === 0 && (
              <p className="text-xs text-muted-foreground">No open positions — everything is in cash.</p>
            )}
            {legs.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="py-1 pr-3">Symbol</th>
                      <th className="py-1 pr-3 text-right">Qty</th>
                      <th className="py-1 pr-3 text-right">Avg cost</th>
                      <th className="py-1 pr-3 text-right">Price</th>
                      <th className="py-1 pr-3 text-right">Value</th>
                      <th className="py-1 text-right">Unrealised</th>
                    </tr>
                  </thead>
                  <tbody>
                    {legs.map((l) => (
                      <tr key={l.symbol} className="border-t border-border/60">
                        <td className="py-1.5 pr-3 font-medium">{l.symbol}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{l.quantity}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{fmt(l.avgCost)}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">
                          {l.price == null ? "—" : fmt(l.price)}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">
                          {l.value == null ? "—" : fmt(l.value)}
                        </td>
                        <td
                          className={`py-1.5 text-right tabular-nums ${
                            (l.pnl ?? 0) < 0 ? "text-destructive" : "text-emerald-600 dark:text-emerald-400"
                          }`}
                        >
                          {l.pnl == null ? "—" : fmt(l.pnl, true)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <FxCashAtRiskCard portfolioId={id} />
        <FxLegRowsCard portfolioId={id} selectedPair={pair} onSelectPair={setPair} />
        <FxLegHistoryCard portfolioId={id} pairFilter={pair ?? undefined} />
        <FxLeverageLadderCard portfolioId={id} pairs={pair ? [pair] : undefined} />

        <Link
          to="/portfolio/$id/fx-risk"
          params={{ id }}
          className="inline-block text-xs text-primary hover:underline"
        >
          Full FX risk dashboard →
        </Link>
      </main>
    </div>
  );
}
