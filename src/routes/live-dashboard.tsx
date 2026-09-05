import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Activity, BookOpen, RefreshCw, Wallet } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { PageShell } from "@/components/layout/page-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LiveTradingCard } from "@/components/live-trading-card";
import { LiveHoldingsCard } from "@/components/live-holdings-card";
import { OrderFillsCard } from "@/components/order-fills-card";
import { getPortfolio, listPortfolios } from "@/lib/portfolios.functions";
import { previewBrokerBalance } from "@/lib/live.functions";
import { getBrokerQuotes, type BrokerQuoteResult } from "@/lib/broker-quotes.functions";
import { useBrokerPriceStream } from "@/hooks/use-broker-price-stream";

const BacktestVsRealCard = lazy(() =>
  import("@/components/backtest-vs-real-card").then((m) => ({ default: m.BacktestVsRealCard })),
);
import { getHoldingsHistory } from "@/lib/holdings-history.functions";
import { derivePortfolioMetrics } from "@/lib/derive-portfolio-metrics";
import { holdingNativeValue } from "@/lib/fx-leg-value";
import { normalizeLseDisplayPriceToBase } from "@/lib/market-price-units";

import { POLL, qk } from "@/lib/query-keys";
import { supabase } from "@/integrations/supabase/client";

type PortfolioRow = {
  id: string;
  name: string;
  currency?: string | null;
  mode?: string | null;
  current_cash?: number | null;
};

type HoldingRow = {
  id: string;
  symbol: string;
  quantity: number | string;
  avg_cost: number | string;
  asset_class?: string | null;
  opened_at?: string | null;
  instrument_ccy?: string | null;
};

export const Route = createFileRoute("/live-dashboard")({
  head: () => ({
    meta: [
      { title: "Live dashboard — Aegis" },
      { name: "description", content: "Live positions, broker orders, fills, and execution P&L." },
    ],
  }),
  component: LiveDashboardPage,
});

function LiveDashboardPage() {
  const list = useServerFn(listPortfolios);
  const get = useServerFn(getPortfolio);
  const getHistory = useServerFn(getHoldingsHistory);
  const portfoliosQ = useQuery({
    queryKey: qk.portfolios.all(),
    queryFn: () => list(),
    refetchInterval: POLL.SEMI_LIVE,
  });
  const portfolios = (portfoliosQ.data ?? []) as PortfolioRow[];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Default to the real-money account, not a sandbox: live_prod first, then a
  // broker-linked live_sim, then anything else.
  const defaultPortfolio = useMemo(() => {
    const rank = (p: PortfolioRow) =>
      p.mode === "live_prod" ? 0 : p.mode === "live_sim" ? 1 : p.mode === "paper" ? 2 : 3;
    return [...portfolios].sort((a, b) => rank(a) - rank(b))[0] ?? null;
  }, [portfolios]);
  const portfolioId = selectedId ?? defaultPortfolio?.id ?? null;
  const portfolioQ = useQuery({
    queryKey: qk.portfolio.detail(portfolioId ?? "none"),
    queryFn: () => get({ data: { id: portfolioId as string } }),
    enabled: Boolean(portfolioId),
    refetchInterval: POLL.SEMI_LIVE,
  });
  const historyQ = useQuery({
    queryKey: ["holdings-history", portfolioId],
    queryFn: () => getHistory({ data: { portfolioId: portfolioId as string } }),
    enabled: Boolean(portfolioId),
    refetchInterval: POLL.SEMI_LIVE,
  });

  useEffect(() => {
    if (!portfolioId) return;
    const channel = supabase
      .channel(`live-dashboard-${portfolioId}`)
      .on("postgres_changes" as never, { event: "*", schema: "public", table: "live_orders", filter: `portfolio_id=eq.${portfolioId}` }, () => {
        void portfolioQ.refetch();
      })
      .on("postgres_changes" as never, { event: "*", schema: "public", table: "live_fills", filter: `portfolio_id=eq.${portfolioId}` }, () => {
        void portfolioQ.refetch();
        void historyQ.refetch();
      })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [portfolioId]);

  const data = portfolioQ.data;
  const selectedMode = (portfolios.find((p) => p.id === portfolioId)?.mode ?? null) as string | null;
  const brokerEnv = selectedMode === "live_prod" ? "live" : selectedMode === "live_sim" ? "sim" : null;
  const balance = useServerFn(previewBrokerBalance);
  const brokerQ = useQuery({
    queryKey: ["live-dashboard-broker-balance", portfolioId, brokerEnv],
    queryFn: () => balance({ data: { env: brokerEnv as "sim" | "live" } }),
    enabled: Boolean(portfolioId && brokerEnv),
    refetchInterval: POLL.SEMI_LIVE,
    retry: false,
  });
  const broker = brokerQ.data ?? null;
  const portfolio = data?.portfolio as (PortfolioRow & { cash_by_ccy?: Record<string, number> | null; currency?: string | null }) | undefined;
  const holdings = (data?.holdings ?? []) as HoldingRow[];
  const equity = (data?.equity ?? []) as Array<{ snapshot_date: string; total_value: number; cash?: number | null }>;
  const latestSnapshot = equity.at(-1) ?? null;
  const metrics = useMemo(() => derivePortfolioMetrics({ latestSnapshot, currentCash: portfolio?.current_cash, holdings }), [latestSnapshot, portfolio?.current_cash, holdings]);
  const history = historyQ.data ?? [];
  // Broker quotes are the venue's own prices; the cached daily tape is only a
  // fallback for instruments Saxo cannot quote.
  const quotes = useServerFn(getBrokerQuotes);
  // Saxo pushes ticks over its streaming socket; the poll below is only the
  // safety net for when the socket is down or an instrument has no feed.
  const stream = useBrokerPriceStream(portfolioId, Boolean(portfolioId));
  // Only real pushed ticks count as streaming; a connected socket that has
  // pushed nothing (closed market, dead feed) must not claim to be live.
  const streamLive = stream.status === "live" && stream.streamedSymbols.length > 0;
  const streamConnected = stream.status === "subscribed" || stream.status === "connecting";

  const quotesQ = useQuery({
    queryKey: ["live-dashboard-broker-quotes", portfolioId],
    queryFn: () => quotes({ data: { portfolioId: portfolioId as string } }),
    enabled: Boolean(portfolioId),
    refetchInterval: streamLive ? POLL.SLOW : POLL.SEMI_LIVE,
    retry: false,
  });
  const brokerQuotes = (quotesQ.data ?? null) as BrokerQuoteResult | null;
  const priceBySymbol = useMemo(() => {
    const map = new Map(history.map((item) => [item.symbol, item.currentPrice]));
    const assetClassBySymbol = new Map(holdings.map((h) => [h.symbol, h.asset_class ?? null]));
    // Streamed ticks win over the polled snapshot for the same symbol.
    const merged: Record<string, { price: number }> = {
      ...(brokerQuotes?.quotes ?? {}),
      ...stream.quotes,
    };
    for (const [symbol, quote] of Object.entries(merged)) {
      // Broker quotes arrive in native units (GBX on most LSE lines); the rest
      // of this page works in base major units, as `history.currentPrice` does.
      const px = normalizeLseDisplayPriceToBase(
        symbol,
        Number(quote.price),
        assetClassBySymbol.get(symbol) ?? null,
      );
      if (Number.isFinite(px) && px > 0) map.set(symbol, px);
    }
    return map;
  }, [history, brokerQuotes, stream.quotes, holdings]);

  const quoteSourceBySymbol = useMemo(
    () => new Set([...Object.keys(brokerQuotes?.quotes ?? {}), ...Object.keys(stream.quotes)]),
    [brokerQuotes, stream.quotes],
  );
  const streamedSymbols = useMemo(() => new Set(stream.streamedSymbols), [stream.streamedSymbols]);

  const positions = useMemo(() => holdings.filter((h) => Number(h.quantity) !== 0).map((h) => {
    const quantity = Number(h.quantity);
    const avgCost = Number(h.avg_cost);
    const price = priceBySymbol.get(h.symbol);
    const value = holdingNativeValue({ assetClass: h.asset_class, quantity, price: price ?? avgCost, avgCost });
    const cost = holdingNativeValue({ assetClass: h.asset_class, quantity, price: avgCost, avgCost });
    return { ...h, quantity, price, value, pnl: price == null ? null : value - cost };
  }).sort((a, b) => Math.abs(b.value) - Math.abs(a.value)), [holdings, priceBySymbol]);
  const currency = String(portfolio?.currency ?? "GBP").toUpperCase();
  const fmtCcy = (n: number, ccy: string) =>
    new Intl.NumberFormat("en-GB", { style: "currency", currency: (ccy || "GBP").toUpperCase(), maximumFractionDigits: 2 }).format(n);
  const fmt = (n: number) => fmtCcy(n, currency);

  return (
    <div className="min-h-screen overflow-x-hidden bg-surface-1">
      <AppHeader />
      <PageShell title="Live dashboard" purpose="Watch broker state as it changes: positions, working orders, actual fills, and money P&L in one dedicated desk." width="wide" actions={
        <div className="flex items-center gap-2">
          {portfolioId && <Badge variant="outline" className="uppercase">{portfolio?.mode ?? "loading"}</Badge>}
          <Button variant="outline" size="sm" onClick={() => { void portfoliosQ.refetch(); void portfolioQ.refetch(); void historyQ.refetch(); }} disabled={portfolioQ.isFetching}>
            <RefreshCw className={`h-4 w-4 ${portfolioQ.isFetching ? "animate-spin" : ""}`} /><span className="ml-1.5">Refresh</span>
          </Button>
        </div>
      }>
        {portfolios.length === 0 && !portfoliosQ.isLoading ? (
          <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">No portfolios available.</CardContent></Card>
        ) : (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
              <div className="flex items-center gap-2 text-sm font-medium"><Activity className="h-4 w-4 text-primary" /> Live execution desk</div>
              <Select value={portfolioId ?? undefined} onValueChange={setSelectedId}>
                <SelectTrigger className="w-full sm:w-[280px]"><SelectValue placeholder="Choose portfolio" /></SelectTrigger>
                <SelectContent>{portfolios.map((p) => <SelectItem key={p.id} value={p.id}>{p.name} · {p.mode ?? "unknown"}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            {!portfolioId || portfolioQ.isLoading ? <p className="text-sm text-muted-foreground">Loading live portfolio…</p> : portfolioQ.isError ? <p className="text-sm text-destructive">Could not load this portfolio: {(portfolioQ.error as Error).message}</p> : portfolio ? (
              <>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <DeskMetric icon={<Wallet className="h-4 w-4" />} label="Account equity" value={broker ? fmtCcy(broker.totalValue, broker.currency) : fmt(metrics.totalValue)} sub={broker ? "Live from broker" : metrics.source === "snapshot" ? "Latest snapshot" : "Fallback estimate"} />
                  <DeskMetric label="Cash" value={broker ? fmtCcy(broker.cash, broker.currency) : fmt(metrics.cash)} sub={broker?.cashAvailable != null ? `${fmtCcy(broker.cashAvailable, broker.currency)} available` : undefined} />
                  <DeskMetric label="Positions value" value={broker ? fmtCcy(broker.positionsValue, broker.currency) : fmt(metrics.invested)} sub={`${broker?.positionsCount ?? positions.length} open`} />
                  <DeskMetric icon={<BookOpen className="h-4 w-4" />} label="Unrealised P&L" value={broker?.unrealizedPnl != null ? fmtCcy(broker.unrealizedPnl, broker.currency) : "—"} sub={brokerQ.isError ? "Broker unavailable" : brokerEnv ? `Saxo ${brokerEnv}` : "Not broker-linked"} />
                </div>
                <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
                  <div className="space-y-4">
                    <LiveHoldingsCard holdings={holdings} currency={currency} cash={metrics.cash} cashByCcy={portfolio.cash_by_ccy ?? null} totalValue={metrics.totalValue} invested={metrics.invested} mode={portfolio.mode ?? "paper"} series={Object.fromEntries(history.map((item) => [item.symbol, item]))} portfolioId={portfolio.id} />
                    <Card>
                      <CardHeader className="pb-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <CardTitle className="text-base">Position details</CardTitle>
                          {streamLive && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-500">
                              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                              Streaming
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          {streamLive
                            ? `Prices stream straight from Saxo on ${streamedSymbols.size} of ${positions.length} positions${stream.lastTickAt ? ` — last update ${new Date(stream.lastTickAt).toLocaleTimeString("en-GB")}` : ""}.`
                            : brokerQuotes && brokerQuotes.covered > 0
                            ? `Live prices on ${brokerQuotes.covered} of ${brokerQuotes.requested} positions (${brokerQuotes.fromBroker} straight from Saxo${brokerQuotes.covered > brokerQuotes.fromBroker ? `, ${brokerQuotes.covered - brokerQuotes.fromBroker} from the market feed` : ""})${brokerQuotes.covered < brokerQuotes.requested ? " — the rest fall back to the cached daily close" : ""}.`
                            : "Live prices unavailable — prices shown are the cached daily close."}

                        </p>
                      </CardHeader>

                      <CardContent>
                        {positions.length === 0 ? <p className="text-sm text-muted-foreground">No open positions.</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground"><th className="pb-2">Symbol</th><th className="pb-2 text-right">Qty</th><th className="pb-2 text-right">Price</th><th className="pb-2 text-right">Value</th><th className="pb-2 text-right">P&amp;L</th></tr></thead><tbody>{positions.map((p) => <tr key={p.id} className="border-b border-border/60"><td className="py-2 font-medium">{p.symbol}</td><td className="py-2 text-right tabular-nums">{p.quantity}</td><td className="py-2 text-right tabular-nums">{p.price == null ? "—" : p.price.toFixed(2)}{quoteSourceBySymbol.has(p.symbol) ? <span className="ml-1 text-[10px] text-muted-foreground">live</span> : null}</td><td className="py-2 text-right tabular-nums">{fmt(p.value)}</td><td className={`py-2 text-right tabular-nums ${p.pnl != null && p.pnl < 0 ? "text-destructive" : "text-emerald-500"}`}>{p.pnl == null ? "—" : fmt(p.pnl)}</td></tr>)}</tbody></table></div>}
                      </CardContent>
                    </Card>
                  </div>
                  <div className="space-y-4">
                    <Card><CardHeader className="pb-3"><CardTitle className="text-base">Live order book &amp; fills</CardTitle></CardHeader><CardContent><OrderFillsCard portfolioId={portfolio.id} /></CardContent></Card>
                    <Suspense fallback={<Card><CardContent className="py-8 text-sm text-muted-foreground">Loading backtest comparison…</CardContent></Card>}>
                      <BacktestVsRealCard portfolioId={portfolio.id} currency={currency} />
                    </Suspense>
                    <LiveTradingCard portfolioId={portfolio.id} />
                  </div>
                </div>
              </>
            ) : null}
          </div>
        )}
      </PageShell>
    </div>
  );
}

function DeskMetric({ icon, label, value, sub }: { icon?: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">{icon}{label}</div>
      <div className="mt-1 text-base font-semibold tabular-nums">{value}</div>
      {sub ? <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}
