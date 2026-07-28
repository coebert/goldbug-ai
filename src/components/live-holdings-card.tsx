import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Briefcase, Wallet, TrendingUp, TrendingDown, ChevronDown, Info } from "lucide-react";
import { Sparkline } from "@/components/sparkline";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  allocateRoundedShares,
  formatMoney,
  formatMoneySigned,
  roundMoney,
} from "@/lib/format-money";
import { normalizeLseDisplayPriceToBase } from "@/lib/market-price-units";
import { useEffect } from "react";
import { auditHoldingSeriesBatch, formatIssue } from "@/lib/holdings-series-sanity";




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
  currentPrice: number | null;
  pctChangeSincePurchase: number | null;
  valueChangeSincePurchase: number | null;
  opened_at?: string | null;
};

export function LiveHoldingsCard({
  holdings,
  currency,
  cash,
  cashByCcy,
  totalValue,
  invested,
  mode,
  series,
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
}) {

  const isLive = mode === "live_prod";

  const rawRows = holdings
    .map((h) => {
      const qty = Number(h.quantity);
      // Fold GBX-quoted LSE stocks into GBP so the raw weight used by
      // largest-remainder allocation is comparable across all rows. Without
      // this, one HSBA row in pence (~1550) dwarfs an ETF row in pounds
      // (~36) by a factor of 100 and the ETFs get 0.0% of the portfolio.
      const avg = normalizeLseDisplayPriceToBase(h.symbol, Number(h.avg_cost), h.asset_class);
      const s = series?.[h.symbol];
      // Prefer live price when we have one, otherwise fall back to cost.
      // `pricedAtCost` flags rows whose value is computed off `avg_cost`
      // because the price cache is missing/stale — the UI shows a badge
      // so users don't mistake a flat P/L row for genuine breakeven.
      const hasLive = s?.currentPrice != null && Number.isFinite(Number(s.currentPrice));
      const mark = hasLive ? Number(s!.currentPrice) : avg;
      const rawValue = qty * mark;
      const costBasis = qty * avg;
      return { ...h, qty, avg, mark, rawValue, costBasis, series: s, pricedAtCost: !hasLive };
    });

  const rawSum = rawRows.reduce((s, r) => s + r.rawValue, 0);
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
  const sortedByValueDesc = rawRows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.rawValue - a.r.rawValue);
  const allocated = allocateRoundedShares(
    sortedByValueDesc.map(({ r }) => Math.max(0, r.rawValue)),
    authoritativeInvested,
  );
  const rows = sortedByValueDesc.map(({ r }, idx) => ({ ...r, value: allocated[idx] }));
  const stalePricedCount = rows.filter((r) => r.pricedAtCost).length;

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
      return new Date(iso).toLocaleDateString("en-GB", {
        timeZone: "Europe/London",
        year: "numeric",
        month: "short",
        day: "numeric",
      });
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
          {isLive && (
            <Badge variant="outline" className="uppercase tracking-wide text-[10px]">
              Real cash
            </Badge>
          )}
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



        {rows.length === 0 ? (
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
              const changePct = s?.pctChangeSincePurchase ?? null;
              const changeVal = s?.valueChangeSincePurchase ?? null;
              const up = (changePct ?? 0) >= 0;
              const openedLabel = fmtOpened(r.opened_at ?? s?.opened_at ?? null);
              const hasSeries = (s?.closes.length ?? 0) >= 2;
              const sparklineBlock = (
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
                  <div className="min-w-0">
                    {hasSeries ? (
                      <Sparkline
                        values={s!.closes}
                        width={220}
                        height={36}
                        className="w-full max-w-full"
                      />
                    ) : (
                      <div
                        className="flex h-9 items-center rounded-md border border-dashed border-border/60 px-2 text-[10px] text-muted-foreground"
                        aria-label="No price history available yet"
                      >
                        No price history yet
                      </div>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    {changePct != null ? (
                      <>
                        <div
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
                        </div>
                        {changeVal != null && (
                          <div
                            className={`text-[11px] tabular-nums ${
                              up ? "text-emerald-500/80" : "text-rose-400/80"
                            }`}
                          >
                            {fmtSigned(changeVal)}
                          </div>
                        )}
                        <div className="text-[10px] text-muted-foreground">since purchase</div>
                      </>
                    ) : (
                      <div className="text-[10px] text-muted-foreground">
                        Awaiting price data
                      </div>
                    )}
                  </div>
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
                        <span className="text-base font-semibold tracking-tight">{r.symbol}</span>
                        {r.asset_class && (
                          <Badge variant="secondary" className="uppercase text-[9px] px-1.5 py-0">
                            {r.asset_class}
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
                        {r.avg.toFixed(2)}
                        {openedLabel && (
                          <span className="ml-1 text-muted-foreground/70">
                            · since {openedLabel}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-base font-semibold tabular-nums">{fmt(r.value)}</div>
                      <div className="text-[11px] text-muted-foreground tabular-nums">
                        {pct.toFixed(1)}% of portfolio
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
                </li>
              );

            })}
          </ul>
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
