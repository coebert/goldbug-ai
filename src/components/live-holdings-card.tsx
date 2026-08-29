import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatUk, formatUkAxisDay, formatUkAxisHour } from "@/lib/uk-time";
import { SymbolTicker } from "@/components/symbol-ticker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Briefcase, Wallet, TrendingUp, TrendingDown, ChevronDown, Info, TrendingDown as SellIcon, RefreshCw } from "lucide-react";
import { Sparkline } from "@/components/sparkline";
import { AxisFramedSparkline } from "@/components/charts/axis-framed-sparkline";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  allocateRoundedShares,
  formatMoney,
  formatMoneyAmount,
  formatMoneySigned,
  roundMoney,
} from "@/lib/format-money";
import { holdingAvgCostBase } from "@/lib/market-price-units";
import { holdingNativeValue, isFxLegHolding } from "@/lib/fx-leg-value";
import { quoteUnitsResolved } from "@/lib/valuation/kernel";
import { useEffect, useState } from "react";
import { auditHoldingSeriesBatch, formatIssue } from "@/lib/holdings-series-sanity";
import { HoldingSellDialog } from "@/components/holding-sell-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { reconcilePortfolio } from "@/lib/live.functions";
import { getFxLegQuotes, type FxLegQuote } from "@/lib/fx-leg-quotes.functions";
import { toast } from "sonner";
import { qk } from "@/lib/query-keys";
import { ValuationFreshnessBadge } from "@/components/valuation-freshness-badge";
import { checkPositionsConsistency } from "@/lib/positions-consistency";




type Holding = {
  id: string;
  symbol: string;
  quantity: number | string;
  avg_cost: number | string;
  asset_class?: string | null;
  opened_at?: string | null;
  instrument_ccy?: string | null;
};

export type HoldingSeriesInfo = {
  closes: number[];
  /** Hour-bucketed prices since purchase (may be empty on older payloads). */
  hourly?: number[];
  hourlyAt?: string[];
  /**
   * Set when the broker's hourly quote stream is stale (no fresher than the
   * latest close yet materially different). Those points are not intraday
   * detail, so the trend falls back to daily closes.
   */
  hourlyStale?: boolean;
  currentPrice: number | null;
  pctChangeSincePurchase: number | null;
  valueChangeSincePurchase: number | null;
  opened_at?: string | null;
};

/**
 * Compact y-axis tick for the holding trend charts.
 *
 * Axis ticks live in a ~48px gutter, so the full "GBP 4,490.96" form does not
 * fit. We keep the ISO code (holdings can be quoted in USD/EUR next to GBP)
 * and drop decimals once the value is large enough that pennies are noise.
 */
function axisTick(n: number, ccy?: string | null): string {
  const code = String(ccy || "GBP").toUpperCase();
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 0 : abs >= 10 ? 1 : 2;
  return `${code} ${formatMoneyAmount(n, digits)}`;
}

export function LiveHoldingsCard({
  holdings,
  currency,
  cash,
  cashByCcy,
  totalValue,
  invested,
  mode,
  series,
  portfolioId,
  allowManualSell = true,
}: {
  holdings: Holding[];
  currency: string;
  cash: number;
  cashByCcy?: Record<string, number> | null;
  totalValue: number;
  /**
   * Optional authoritative invested amount (FX/GBX-normalised, from the
   * shared `derivePortfolioMetrics` helper). When supplied it is used
   * verbatim so this card cannot disagree with the equity/cash tiles.
   * When omitted, we fall back to `max(0, totalValue - cash)`.
   */
  invested?: number;
  mode: string;
  series?: Record<string, HoldingSeriesInfo>;
  /** When provided, enables per-row manual sell buttons. */
  portfolioId?: string;
  allowManualSell?: boolean;
}) {
  const [sellTarget, setSellTarget] = useState<Holding | null>(null);
  // Trend resolution shared by every row so the rows stay comparable.
  const [trendRes, setTrendRes] = useState<"hourly" | "daily">("hourly");
  const hasHourly = Object.values(series ?? {}).some(
    (s) => !s.hourlyStale && (s.hourly?.length ?? 0) >= 2,
  );
  const resolution = hasHourly ? trendRes : "daily";

  const isLive = mode === "live_prod";
  const isAnyLive = mode === "live_prod" || mode === "live_sim";

  // Manual "Sync now" — pulls cash + positions + order statuses from Saxo and
  // rewrites local holdings + today's equity snapshot. Auto-sync every 5min
  // handles the passive case; this button is for when the user wants the
  // tile to catch up immediately after they know a trade filled.
  const qc = useQueryClient();
  const reconcileFn = useServerFn(reconcilePortfolio);

  // FX funding legs are not in `price_cache` (no GBPUSD rows) and carry a
  // negative quantity, so the holdings price-series query skips them and the
  // leg used to render frozen at its entry rate with 0.00 P&L. Mark them to
  // the live FX feed on a 60s poll instead.
  const hasFxLeg = holdings.some((h) => isFxLegHolding({ asset_class: h.asset_class ?? null }));
  const fxQuotesFn = useServerFn(getFxLegQuotes);
  const fxQuotesQuery = useQuery({
    queryKey: ["fx-leg-quotes", portfolioId],
    enabled: Boolean(portfolioId) && hasFxLeg,
    queryFn: () => fxQuotesFn({ data: { portfolioId: portfolioId as string } }),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
  const fxQuoteBySymbol = new Map<string, FxLegQuote>(
    (fxQuotesQuery.data?.legs ?? []).map((l) => [l.symbol.toUpperCase(), l]),
  );
  const syncMut = useMutation({
    mutationFn: () => {
      if (!portfolioId) throw new Error("portfolioId required");
      return reconcileFn({ data: { portfolioId } });
    },
    onSuccess: (r) => {
      const res = (r ?? {}) as {
        drift?: boolean;
        cashDrift?: number;
        positionDrift?: string[];
        brokerCash?: number;
        brokerTotalValue?: number;
        currency?: string;
        brokerPositions?: Array<{ symbol: string; quantity: number }>;
      };
      const ccy = res.currency ?? "GBP";
      const count = res.brokerPositions?.length ?? 0;
      const total = res.brokerTotalValue;
      const cash = res.brokerCash;
      const summary =
        total != null && cash != null
          ? `Saxo: ${count} position${count === 1 ? "" : "s"} · cash ${ccy} ${cash.toFixed(2)} · total ${ccy} ${total.toFixed(2)}`
          : `Saxo returned ${count} position${count === 1 ? "" : "s"}`;
      if (res.drift) {
        const posDetail = (res.positionDrift ?? []).slice(0, 4).join(", ");
        toast.warning(`Drift vs broker — ${summary}`, {
          description: posDetail || (res.cashDrift ? `cash Δ=${res.cashDrift.toFixed(2)}` : undefined),
          duration: 8000,
        });
      } else {
        toast.success(`Up to date with Saxo`, { description: summary, duration: 6000 });
      }
      if (portfolioId) {
        qc.invalidateQueries({ queryKey: qk.portfolio.detail(portfolioId) });
        qc.invalidateQueries({ queryKey: ["holdings-history", portfolioId] });
        qc.invalidateQueries({ queryKey: qk.live.status(portfolioId) });
      }
    },
    onError: (e: Error) => toast.error(`Sync failed: ${e.message}`),
  });

  // Runtime sanity: sparklines and headline % must agree. Report once per
  // change to the series payload so console spam is bounded.
  useEffect(() => {
    if (!series) return;
    const list = Object.entries(series).map(([symbol, s]) => ({
      symbol,
      avg_cost: s.closes[0] ?? 0,
      closes: s.closes,
      currentPrice: s.currentPrice,
      pctChangeSincePurchase: s.pctChangeSincePurchase,
      points: s.closes.length,
    }));
    const issues = auditHoldingSeriesBatch(list);
    for (const i of issues) console.warn(formatIssue(i));
  }, [series]);

  const baseCcyForUnits = String(currency ?? "GBP").toUpperCase();
  const rawRows = holdings
    .map((h) => {
      const qty = Number(h.quantity);
      // Fold GBX-quoted LSE stocks into GBP so the raw weight used by
      // largest-remainder allocation is comparable across all rows. Without
      // this, one HSBA row in pence (~1550) dwarfs an ETF row in pounds
      // (~36) by a factor of 100 and the ETFs get 0.0% of the portfolio.
      const avg = holdingAvgCostBase(h.symbol, h.avg_cost);
      const s = series?.[h.symbol];
      // Prefer live price when we have one, otherwise fall back to cost.
      // `pricedAtCost` flags rows whose value is computed off `avg_cost`
      // because the price cache is missing/stale — the UI shows a badge
      // so users don't mistake a flat P/L row for genuine breakeven.
      const hasLive = s?.currentPrice != null && Number.isFinite(Number(s.currentPrice));
      const mark = hasLive ? Number(s!.currentPrice) : avg;
      // Fail-safe: if we cannot tell whether this ticker is quoted in pence
      // or pounds (no observed quote currency, no stored instrument_ccy, no
      // recognised venue), any money figure or percentage would be a guess
      // that is either right or 100x wrong. Weight the row at zero and render
      // it as unknown rather than publishing a fabricated number.
      const unitsUnknown = !quoteUnitsResolved(h.symbol, h.instrument_ccy ?? null, null, baseCcyForUnits);
      const rawValue = unitsUnknown ? 0 : qty * mark;
      const costBasis = unitsUnknown ? 0 : qty * avg;
      return { ...h, qty, avg, mark, rawValue, costBasis, series: s, unitsUnknown, pricedAtCost: !hasLive && !unitsUnknown };
    });

  // FX spot legs (e.g. a short GBPUSD funding leg the engine opened to buy a
  // USD instrument) are NOT ordinary positions: their notional already lives
  // in the cash wallet, so qty x price would double-count it. Previously they
  // fell through the shared allocation path, which clamps negative raw values
  // to zero — the leg rendered as a £0.00 / 0.0% row and looked invisible.
  // They now get their own section showing notional and unrealised P&L.
  const isFxRow = (r: { asset_class?: string | null }) => isFxLegHolding({ asset_class: r.asset_class ?? null });
  const fxLegRows = rawRows.filter(isFxRow).map((r) => {
    const q = fxQuoteBySymbol.get(String(r.symbol).toUpperCase());
    const liveRate = q?.rate != null && Number.isFinite(q.rate) && q.rate > 0 ? q.rate : null;
    const mark = liveRate ?? (Number.isFinite(r.mark) ? r.mark : r.avg);
    return {
      ...r,
      mark,
      liveRate,
      quote: q ?? null,
      notional: q?.notionalQuote ?? Math.abs(r.qty) * mark,
      pnl:
        q?.pnlQuote ??
        holdingNativeValue({
          assetClass: r.asset_class ?? null,
          quantity: r.qty,
          price: mark,
          avgCost: r.avg,
        }),
    };
  });
  const positionRows = rawRows.filter((r) => !isFxRow(r));

  const rawSum = positionRows.reduce((s, r) => s + r.rawValue, 0);

  // Authoritative invested value: prefer the parent-supplied number (from
  // `derivePortfolioMetrics`, which reads the server-side equity snapshot),
  // otherwise derive from `totalValue - cash`. Raw qty × price is in native
  // units (USD, GBX, EUR) and cannot be summed as base currency — doing so
  // would produce a > 100% "invested" tile.
  const parentInvested =
    typeof invested === "number" && Number.isFinite(invested) && invested >= 0
      ? invested
      : null;
  const authoritativeInvestedRaw =
    parentInvested != null
      ? parentInvested
      : Number.isFinite(totalValue) && totalValue > 0
        ? Math.max(0, Number(totalValue) - Number(cash))
        : rawSum;
  // Round every displayed money value on the same 2dp/halfExpand grid so
  // per-position rows sum bit-exactly to the Invested tile and the Cash +
  // Invested tiles sum bit-exactly to the Total headline.
  const authoritativeInvested = roundMoney(authoritativeInvestedRaw);
  const cashDisplay = roundMoney(cash);
  const totalDisplay = roundMoney(
    Number.isFinite(totalValue) && totalValue > 0
      ? totalValue
      : authoritativeInvested + cashDisplay,
  );
  // Largest-remainder split of Invested across positions — guarantees
  // Σ(row.value) === authoritativeInvested at 2dp.
  const sortedByValueDesc = positionRows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.rawValue - a.r.rawValue);
  const allocated = allocateRoundedShares(
    sortedByValueDesc.map(({ r }) => Math.max(0, r.rawValue)),
    authoritativeInvested,
  );
  const rows = sortedByValueDesc.map(({ r }, idx) => ({ ...r, value: allocated[idx] }));
  const stalePricedCount = rows.filter((r) => r.pricedAtCost).length;

  // Reconcile what the engine holds against what this card actually paints:
  // every non-FX position rendered exactly once, quantities equal, and the
  // per-row values summing to the Invested tile. FX funding legs are counted
  // separately because they render in their own section by design.
  const consistency = checkPositionsConsistency({
    enginePositions: holdings.map((h) => ({
      symbol: h.symbol,
      quantity: Number(h.quantity),
      isFxLeg: isFxLegHolding({ asset_class: h.asset_class ?? null }),
    })),
    renderedPositions: rows.map((r) => ({ symbol: r.symbol, quantity: r.qty, value: r.value })),
    investedTotal: authoritativeInvested,
  });

  const holdingsValue = authoritativeInvested;
  const denom = totalDisplay > 0 ? totalDisplay : holdingsValue + cashDisplay;
  const cashPct = denom > 0 ? (cashDisplay / denom) * 100 : 0;

  // Per-currency native breakdown (no FX conversion). We show this whenever
  // the account holds cash or positions in more than one currency, so users
  // can see raw USD/EUR/GBP totals rather than only the converted base view.
  const baseCcy = String(currency ?? "").toUpperCase();
  const investedByCcy = new Map<string, number>();
  for (const r of rows) {
    const ccy = String(r.instrument_ccy || baseCcy).toUpperCase();
    investedByCcy.set(ccy, roundMoney((investedByCcy.get(ccy) ?? 0) + r.value));
  }
  const cashCcyMap = new Map<string, number>();
  if (cashByCcy && typeof cashByCcy === "object") {
    for (const [k, v] of Object.entries(cashByCcy)) {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      cashCcyMap.set(String(k).toUpperCase(), roundMoney(n));
    }
  }
  if (cashCcyMap.size === 0 && Number.isFinite(cash)) {
    cashCcyMap.set(baseCcy, cashDisplay);
  }
  const allCcys = Array.from(
    new Set<string>([...investedByCcy.keys(), ...cashCcyMap.keys()]),
  ).sort((a, b) => (a === baseCcy ? -1 : b === baseCcy ? 1 : a.localeCompare(b)));
  const showMultiCcy = allCcys.length > 1;
  // All money formatting flows through the shared helpers so the tiles,
  // per-position rows, and multi-ccy breakdown share one rounding /
  // grouping / -0 policy (see src/lib/format-money.ts).
  const fmtCcy = (ccy: string, n: number) => formatMoney(n, ccy);
  const fmt = (n: number) => formatMoney(n, currency);
  const fmtSigned = (n: number) => formatMoneySigned(n, currency);


  const fmtPct = (p: number) => {
    const sign = p > 0 ? "+" : p < 0 ? "−" : "";
    return `${sign}${Math.abs(p * 100).toFixed(2)}%`;
  };

  const fmtOpened = (iso?: string | null) => {
    if (!iso) return null;
    try {
      return formatUk(iso, { year: "numeric", month: "short", day: "numeric" });
    } catch {
      return null;
    }
  };

  return (
    <Card className={isLive ? "border-primary/40 shadow-sm" : undefined}>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Briefcase className="h-4 w-4" />
            {isLive ? "Live positions" : "Holdings"}
            <Badge variant={isLive ? "default" : "secondary"} className="ml-1">
              {rows.length} {rows.length === 1 ? "position" : "positions"}
            </Badge>
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            {isAnyLive && portfolioId && (
              <ValuationFreshnessBadge portfolioId={portfolioId} />
            )}
            {isLive && (
              <Badge variant="outline" className="uppercase tracking-wide text-[10px]">
                Real cash
              </Badge>
            )}
            {hasHourly && (
              <div
                className="flex overflow-hidden rounded-md border text-[11px]"
                role="group"
                aria-label="Price trend resolution"
              >
                {(["hourly", "daily"] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setTrendRes(r)}
                    aria-pressed={resolution === r}
                    className={`px-2 py-1 capitalize transition-colors ${
                      resolution === r
                        ? "bg-secondary text-secondary-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            )}
            {isAnyLive && portfolioId && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1.5 px-2 text-xs"
                onClick={() => syncMut.mutate()}
                disabled={syncMut.isPending}
                aria-label="Sync holdings and cash from Saxo"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${syncMut.isPending ? "animate-spin" : ""}`} />
                {syncMut.isPending ? "Syncing…" : "Sync now"}
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <TooltipProvider delayDuration={150}>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground sm:text-xs">
                <TrendingUp className="h-3.5 w-3.5 shrink-0" /> Invested
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label="What Invested includes"
                      className="inline-flex text-muted-foreground/70 hover:text-foreground"
                    >
                      <Info className="h-3 w-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-[260px] text-xs leading-snug">
                    <div className="font-medium">Market value of open positions</div>
                    <div className="mt-1 text-muted-foreground">
                      Includes: quantity × current price for every holding, normalised to the
                      portfolio's base currency (FX / GBX-adjusted).
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      Excludes: cash, pending orders, and any deposits still sitting as cash.
                    </div>
                  </TooltipContent>
                </Tooltip>
              </div>
              <div className="mt-1 text-base font-semibold leading-tight tabular-nums sm:text-lg">{fmt(holdingsValue)}</div>
              <div className="text-[10px] text-muted-foreground sm:text-[11px]">
                {denom > 0 ? `${(100 - cashPct).toFixed(0)}% of portfolio` : "—"}
              </div>
            </div>
            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground sm:text-xs">
                <Wallet className="h-3.5 w-3.5 shrink-0" /> Cash
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label="What Cash includes"
                      className="inline-flex text-muted-foreground/70 hover:text-foreground"
                    >
                      <Info className="h-3 w-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-[260px] text-xs leading-snug">
                    <div className="font-medium">Uninvested balance</div>
                    <div className="mt-1 text-muted-foreground">
                      Includes: settled cash from deposits, sale proceeds, dividends, and
                      interest, converted to base currency.
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      Excludes: cash reserved by working orders and the market value of open
                      positions.
                    </div>
                  </TooltipContent>
                </Tooltip>
              </div>
              <div className="mt-1 text-base font-semibold leading-tight tabular-nums sm:text-lg">{fmt(cashDisplay)}</div>
              <div className="text-[10px] text-muted-foreground sm:text-[11px]">
                {denom > 0 ? `${cashPct.toFixed(0)}% of portfolio` : "—"}
              </div>
            </div>
          </div>
        </TooltipProvider>

        {showMultiCcy && (
          <div className="rounded-lg border bg-muted/20 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-xs font-medium text-muted-foreground">
                By currency
              </div>
              <div className="text-[10px] text-muted-foreground">
                native totals · no FX conversion
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs tabular-nums">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    <th className="py-1 pr-3 text-left font-medium">Ccy</th>
                    <th className="py-1 pr-3 text-right font-medium">Invested</th>
                    <th className="py-1 pr-3 text-right font-medium">Cash</th>
                    <th className="py-1 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {allCcys.map((ccy) => {
                    const inv = investedByCcy.get(ccy) ?? 0;
                    const csh = cashCcyMap.get(ccy) ?? 0;
                    const total = inv + csh;
                    return (
                      <tr key={ccy} className="border-t border-border/40">
                        <td className="py-1.5 pr-3 font-medium">
                          {ccy}
                          {ccy === baseCcy && (
                            <span className="ml-1 text-[9px] uppercase text-muted-foreground">
                              base
                            </span>
                          )}
                        </td>
                        <td className="py-1.5 pr-3 text-right">{fmtCcy(ccy, inv)}</td>
                        <td className="py-1.5 pr-3 text-right">{fmtCcy(ccy, csh)}</td>
                        <td className="py-1.5 text-right font-semibold">
                          {fmtCcy(ccy, total)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}



        {holdings.length > 0 && (
          <div
            data-testid="positions-consistency"
            data-ok={consistency.ok ? "true" : "false"}
            className={`mb-3 rounded-md border px-3 py-2 text-[11px] leading-relaxed ${
              consistency.ok
                ? "border-border/50 bg-muted/20 text-muted-foreground"
                : "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
            }`}
          >
            {consistency.summary}
            {consistency.ok && (
              <span className="tabular-nums">
                {" "}· rows total {fmt(consistency.renderedTotal)} = invested {fmt(consistency.investedTotal)}
              </span>
            )}
          </div>
        )}

        {fxLegRows.length > 0 && (
          <div className="mb-3 rounded-lg border border-border/60 bg-muted/20 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                FX legs (funding)
              </div>
              <span className="text-[10px] text-muted-foreground">
                notional sits in cash · P&amp;L only
                {fxQuotesQuery.data?.asOf &&
                  ` · rates ${formatUk(fxQuotesQuery.data.asOf, { timeStyle: "short" })}`}
                {fxQuotesQuery.isFetching && " · updating…"}
              </span>
            </div>
            <ul className="space-y-1.5" data-testid="fx-legs-list">
              {fxLegRows.map((r) => {
                const short = r.qty < 0;
                const q = r.quote;
                const quoteCcy = (
                  q?.quoteCcy ||
                  String(r.instrument_ccy || r.symbol.slice(3, 6) || baseCcy)
                ).toUpperCase();
                const gain = r.pnl >= 0;
                const closeCcy = q ? fxQuotesQuery.data?.baseCcy ?? baseCcy : quoteCcy;
                // Close-now is NET of the exit conversion fee (spread + min
                // ticket) — the gross mark overstates what you'd pocket.
                const closeValue = q ? q.pnlBaseNet : r.pnl;
                const closeGain = closeValue >= 0;
                return (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-center justify-between gap-2 text-sm"
                    data-testid={`fx-leg-${r.symbol}`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <SymbolTicker symbol={r.symbol} className="font-semibold tracking-tight" />
                        <Badge variant="secondary" className="uppercase text-[9px] px-1.5 py-0">
                          {short ? "short" : "long"} fx
                        </Badge>
                        {q?.stale && (
                          <Badge variant="outline" className="text-[9px] px-1.5 py-0">
                            rate stale
                          </Badge>
                        )}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                        {r.qty.toLocaleString(undefined, { maximumFractionDigits: 2 })} @ {r.avg.toFixed(4)} entry
                        {r.liveRate != null
                          ? ` · ${r.liveRate.toFixed(4)} now`
                          : Number.isFinite(r.mark)
                            ? ` · ${r.mark.toFixed(4)} now`
                            : ""}
                      </div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        Close now:{" "}
                        <span className={closeGain ? "text-emerald-500" : "text-rose-400"}>
                          {closeGain ? "you'd gain " : "you'd lose "}
                          {formatMoneyAmount(Math.abs(closeValue))} {closeCcy}
                        </span>
                        {q != null && q.exitFeeBase > 0 && (
                          <span>
                            {" "}after ~{formatMoneyAmount(q.exitFeeBase)} {closeCcy} fees
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-right">
                      <div
                        className={`text-sm font-semibold tabular-nums ${gain ? "text-emerald-500" : "text-rose-400"}`}
                      >
                        {formatMoneySigned(r.pnl, quoteCcy)}
                      </div>
                      <div className="text-[11px] text-muted-foreground tabular-nums">
                        {formatMoneyAmount(r.notional)} {quoteCcy} notional
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {rows.length === 0 && fxLegRows.length === 0 ? (

          <p className="text-sm text-muted-foreground">
            {isLive
              ? "No positions held at your broker right now. The AI will open positions on the next run when opportunities fit your budget."
              : "Fully in cash."}
          </p>
        ) : (
          <ul className="space-y-2">
            {rows.map((r) => {
              const pct = denom > 0 ? (r.value / denom) * 100 : 0;
              const s = r.series;
              // Percentages are withheld entirely when units are unknown.
              const changePct = r.unitsUnknown ? null : (s?.pctChangeSincePurchase ?? null);
              const changeVal = r.unitsUnknown ? null : (s?.valueChangeSincePurchase ?? null);
              const up = (changePct ?? 0) >= 0;
              const openedLabel = fmtOpened(r.opened_at ?? s?.opened_at ?? null);
              const hourlyPts = s?.hourlyStale ? [] : (s?.hourly ?? []);
              const useHourly = resolution === "hourly" && hourlyPts.length >= 2;
              const trendValues = useHourly ? hourlyPts : (s?.closes ?? []);
              const hasSeries = trendValues.length >= 2;
              const trendLabel = useHourly
                ? `${hourlyPts.length} hourly points`
                : `${s?.closes.length ?? 0} daily closes`;
              // X-axis end points. Hourly series carry real timestamps; the
              // daily series is anchored at the purchase date and runs to the
              // latest close, so we label it with the purchase date and "now".
              const hourlyAt = s?.hourlyAt ?? [];
              const xStart = useHourly
                ? formatUkAxisHour(hourlyAt[0] ?? r.opened_at ?? new Date())
                : (openedLabel || formatUkAxisDay(new Date()));
              const xEnd = useHourly
                ? formatUkAxisHour(hourlyAt[hourlyAt.length - 1] ?? new Date())
                : formatUkAxisDay(new Date());
              const sparklineBlock = (
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    {changePct != null ? (
                      <div className="flex items-baseline gap-2">
                        <span
                          className={`inline-flex items-center gap-1 text-xs font-semibold tabular-nums ${
                            up ? "text-emerald-500" : "text-rose-400"
                          }`}
                        >
                          {up ? (
                            <TrendingUp className="h-3 w-3" />
                          ) : (
                            <TrendingDown className="h-3 w-3" />
                          )}
                          {fmtPct(changePct)}
                        </span>
                        {changeVal != null && (
                          <span
                            className={`text-[11px] tabular-nums ${
                              up ? "text-emerald-500/80" : "text-rose-400/80"
                            }`}
                          >
                            {fmtSigned(changeVal)}
                          </span>
                        )}
                        <span className="text-[10px] text-muted-foreground">since purchase</span>
                      </div>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">
                        Awaiting price data
                      </span>
                    )}
                    {hasSeries && (
                      <span className="shrink-0 text-[10px] text-muted-foreground/70">
                        {trendLabel}
                      </span>
                    )}
                  </div>
                  {hasSeries ? (
                    // Full-bleed and axis-framed: the line fills the row and
                    // carries a price axis (holding currency) plus a time axis
                    // so a reader can tell what the trend is worth and when.
                    <AxisFramedSparkline
                      values={trendValues}
                      formatValue={(n) => axisTick(n, r.instrument_ccy || currency)}
                      xStart={xStart}
                      xEnd={xEnd}
                      xUnit={useHourly ? "hourly" : "daily closes"}
                      valueAxisLabel={`${r.symbol} price`}
                      label={`${r.symbol} price trend, ${trendLabel}`}
                    />
                  ) : (

                    <div
                      className="flex h-14 items-center justify-center rounded-md border border-dashed border-border/60 px-2 text-[10px] text-muted-foreground sm:h-16"
                      aria-label="No price history available yet"
                    >
                      {resolution === "hourly" && hourlyPts.length < 2
                        ? "Hourly detail builds up as syncs run"
                        : "No price history yet"}
                    </div>
                  )}
                </div>
              );
              return (
                <li
                  key={r.id}
                  className="rounded-lg border p-3 hover:bg-muted/40 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <SymbolTicker
                          symbol={r.symbol}
                          className="text-base font-semibold tracking-tight"
                        />
                        {r.asset_class && (
                          <Badge variant="secondary" className="uppercase text-[9px] px-1.5 py-0">
                            {r.asset_class}
                          </Badge>
                        )}
                        {r.unitsUnknown && (
                          <Badge
                            variant="outline"
                            className="border-rose-500/50 bg-rose-500/10 text-rose-400 text-[9px] px-1.5 py-0"
                            title="Price units for this ticker could not be resolved to pence (GBX) or pounds (GBP), so its value and percentage change are withheld rather than shown as a possibly 100x-wrong number."
                          >
                            units unknown
                          </Badge>
                        )}
                        {r.pricedAtCost && (
                          <Badge
                            variant="outline"
                            className="border-amber-500/50 bg-amber-500/10 text-amber-500 text-[9px] px-1.5 py-0"
                            title="Live price unavailable — value shown uses average cost as a proxy."
                          >
                            @ cost
                          </Badge>
                        )}
                        {changePct != null && (
                          <span
                            className={`sm:hidden inline-flex items-center gap-0.5 rounded px-1 text-[10px] font-semibold tabular-nums ${
                              up ? "text-emerald-500" : "text-rose-400"
                            }`}
                          >
                            {up ? <TrendingUp className="h-2.5 w-2.5" /> : <TrendingDown className="h-2.5 w-2.5" />}
                            {fmtPct(changePct)}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground tabular-nums break-words">
                        {r.qty.toLocaleString(undefined, { maximumFractionDigits: 4 })} @ {currency}{" "}
                        {r.avg.toFixed(2)} cost
                        {openedLabel && (
                          <span className="ml-1 text-muted-foreground/70">
                            · since {openedLabel}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-base font-semibold tabular-nums">
                        {r.unitsUnknown ? "—" : fmt(r.value)}
                      </div>
                      <div className="text-[11px] text-muted-foreground tabular-nums">
                        {r.unitsUnknown ? "units unresolved" : `${pct.toFixed(1)}% of portfolio`}
                      </div>
                    </div>
                  </div>

                  {/* Mobile: accordion — tap to reveal sparkline + change */}
                  <details className="sm:hidden group mt-2 [&_summary::-webkit-details-marker]:hidden">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground">
                      <span>Show price trend</span>
                      <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
                    </summary>
                    <div className="mt-2">{sparklineBlock}</div>
                  </details>

                  {/* Desktop / tablet: sparkline always visible */}
                  <div className="hidden sm:block mt-2">{sparklineBlock}</div>

                  <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full bg-primary/70"
                      style={{ width: `${Math.min(100, pct)}%` }}
                    />
                  </div>

                  {allowManualSell && portfolioId && (
                    <div className="mt-2 flex justify-end">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs"
                        onClick={() => {
                          const src = holdings.find((x) => x.id === r.id);
                          if (src) setSellTarget(src);
                        }}
                      >
                        <SellIcon className="mr-1 h-3 w-3" />
                        Sell now
                      </Button>
                    </div>
                  )}
                </li>
              );

            })}
          </ul>
        )}

        {sellTarget && (
          <HoldingSellDialog
            holding={{
              id: sellTarget.id,
              symbol: sellTarget.symbol,
              quantity: Number(sellTarget.quantity),
              asset_class: sellTarget.asset_class ?? null,
              instrument_ccy: sellTarget.instrument_ccy ?? null,
            }}
            mode={mode}
            onClose={() => setSellTarget(null)}
          />
        )}


        {isLive && (
          <p className="text-[11px] text-muted-foreground">
            Values shown at latest close where available, otherwise at broker average cost. Live
            market prices are re-synced during each run and reconciliation.
          </p>
        )}
        {stalePricedCount > 0 && (
          <p
            className="text-[11px] text-amber-500"
            role="status"
            title="These holdings are priced at their average cost because the price cache has no fresh quote — realised value may drift from live market once quotes return."
          >
            ⚠ {stalePricedCount} holding{stalePricedCount === 1 ? "" : "s"} priced at average
            cost — price cache stale.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
