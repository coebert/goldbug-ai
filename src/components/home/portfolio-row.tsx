import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  AlertCircle,
  Banknote,
  Briefcase,
  Info,
  MoreVertical,
  Pencil,
  PlayCircle,
  RefreshCw,
  Trash2,
  Wallet,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import { Sparkline } from "@/components/sparkline";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ModeBadge } from "@/components/mode-badge";
import { LiveToggle } from "@/components/live-toggle";
import { RenamePortfolioDialog } from "@/components/rename-portfolio-dialog";
import { AddSimFundsDialog } from "@/components/add-sim-funds-dialog";

import { deletePortfolio } from "@/lib/trading.functions";
import { buildDepositAdjustedSeries } from "@/lib/deposit-adjusted-series";
import { deriveCardEquity } from "@/lib/derive-card-equity";
import { formatMoney, formatMoneyAmount } from "@/lib/format-money";

export type SparkPoint = { date: string; value: number };
export type SparkRange = "1W" | "1M" | "3M" | "1Y" | "All";
export const SPARK_RANGES: { key: SparkRange; days: number | null }[] = [
  { key: "1W", days: 7 },
  { key: "1M", days: 30 },
  { key: "3M", days: 90 },
  { key: "1Y", days: 365 },
  { key: "All", days: null },
];

export type PortfolioHoldingSummary = {
  symbol: string;
  quantity: number;
  avg_cost: number;
  asset_class?: string | null;
};

export function PortfolioRow({
  portfolio,
  sparkSeries,
  deposits = [],
  includeDeposits = false,
  isLoadingEquity = false,
  isRefreshingEquity = false,
  equityError = null,
  onRetryEquity,
  equityDecimals = 2,
  defaultRange = "1M",
  brokerCurrency = null,
  holdings = [],
}: {
  portfolio: {
    id: string;
    name: string;
    starting_cash: number;
    current_cash: number;
    currency: string;
    risk_level: string;
    mode: string;
    live_paused?: boolean | null;
    last_run_date: string | null;
  };
  sparkSeries: SparkPoint[];
  deposits?: Array<{ date: string; amount: number }>;
  includeDeposits?: boolean;
  isLoadingEquity?: boolean;
  isRefreshingEquity?: boolean;
  equityError?: string | null;
  onRetryEquity?: () => void;
  equityDecimals?: number;
  defaultRange?: SparkRange;
  brokerCurrency?: string | null;
  holdings?: PortfolioHoldingSummary[];
}) {
  const [sparkRange, setSparkRange] = useState<SparkRange>(defaultRange);
  const sliced = useMemo(() => {
    const opt = SPARK_RANGES.find((r) => r.key === sparkRange)!;
    if (!opt.days || sparkSeries.length === 0) return sparkSeries;
    const cutoff = Date.now() - opt.days * 86_400_000;
    const s = sparkSeries.filter((p) => {
      const t = Date.parse(p.date);
      return Number.isFinite(t) ? t >= cutoff : true;
    });
    return s.length >= 2 ? s : sparkSeries.slice(-2);
  }, [sparkSeries, sparkRange]);
  const adjusted = useMemo(
    () =>
      buildDepositAdjustedSeries(
        sliced.map((p) => ({ date: p.date, equity: p.value })),
        includeDeposits ? [] : deposits,
      ),
    [sliced, deposits, includeDeposits],
  );
  const values = adjusted.length > 0 ? adjusted.map((p) => p.adjusted) : sliced.map((p) => p.value);
  const { totalEquity, rangePct } = deriveCardEquity(
    sparkSeries,
    sliced,
    deposits,
    includeDeposits,
    Number(portfolio.current_cash),
  );
  const equityLoading = isLoadingEquity && sparkSeries.length === 0;
  const equityEmpty = !isLoadingEquity && sparkSeries.length === 0;
  const del = useServerFn(deletePortfolio);
  const qc = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [addFundsOpen, setAddFundsOpen] = useState(false);
  const isSim = portfolio.mode !== "live_prod";
  const isLive = portfolio.mode === "live_sim" || portfolio.mode === "live_prod";
  const portfolioCcy = String(portfolio.currency || "").toUpperCase();
  const brokerCcy = brokerCurrency ? brokerCurrency.toUpperCase() : null;
  const currencyMismatch = isLive && !!brokerCcy && brokerCcy !== portfolioCcy;

  const deleteMut = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: () => {
      toast.success("Portfolio deleted");
      qc.invalidateQueries({ queryKey: ["portfolios"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const pnl = Number(portfolio.current_cash) - Number(portfolio.starting_cash);
  const pnlPct = Number(portfolio.starting_cash) > 0 ? (pnl / Number(portfolio.starting_cash)) * 100 : 0;

  return (
    <Card>
      <CardContent className="p-4 sm:p-5">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                to="/portfolio/$id"
                params={{ id: portfolio.id }}
                className="truncate text-base font-semibold hover:underline"
              >
                {portfolio.name}
              </Link>
              <ModeBadge mode={portfolio.mode} size="sm" />
              <LiveToggle
                portfolioId={portfolio.id}
                mode={portfolio.mode}
                livePaused={portfolio.live_paused}
                size="sm"
              />
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {portfolio.currency} {Number(portfolio.starting_cash).toFixed(0)} · {portfolio.risk_level} risk
              {portfolio.last_run_date && ` · last run ${portfolio.last_run_date}`}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Link to="/portfolio/$id" params={{ id: portfolio.id }}>
              <Button size="sm" variant="outline" className="h-10">
                <PlayCircle className="mr-1 h-4 w-4" /> Open
              </Button>
            </Link>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-10 w-10"
                  aria-label={`More actions for ${portfolio.name}`}
                >
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <Link to="/portfolio/$id" params={{ id: portfolio.id }}>
                    Open portfolio
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={(e) => {
                    e.preventDefault();
                    setRenameOpen(true);
                  }}
                >
                  <Pencil className="mr-2 h-4 w-4" /> Rename portfolio
                </DropdownMenuItem>
                {isSim && (
                  <DropdownMenuItem
                    onSelect={(e) => {
                      e.preventDefault();
                      setAddFundsOpen(true);
                    }}
                  >
                    <Banknote className="mr-2 h-4 w-4" /> Add simulated funds
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={(e) => {
                    e.preventDefault();
                    setConfirmDelete(true);
                  }}
                >
                  <Trash2 className="mr-2 h-4 w-4" /> Delete portfolio
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {currencyMismatch ? (
          <div
            role="alert"
            data-testid="broker-currency-mismatch-warning"
            data-portfolio-ccy={portfolioCcy}
            data-broker-ccy={brokerCcy}
            className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <div className="min-w-0">
              <div className="font-semibold">
                Broker currency mismatch ({brokerCcy} vs {portfolioCcy})
              </div>
              <div className="mt-0.5 text-destructive/80">
                P&amp;L and % change are blocked — broker balance is in {brokerCcy} but this portfolio
                accounts in {portfolioCcy}. Values aren't comparable until an FX conversion or account
                re-denomination is in place.
              </div>
            </div>
          </div>
        ) : null}


        <div
          className={`mt-3 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3 border-t border-border/60 pt-3 transition-opacity ${isRefreshingEquity ? "opacity-90" : ""}`}
          aria-busy={isRefreshingEquity || undefined}
          data-refreshing={isRefreshingEquity ? "true" : undefined}
          data-testid="portfolio-row-equity"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Sparkline values={values} width={120} height={32} />
              {equityError ? (
                <span
                  data-testid="range-pct-error"
                  role="status"
                  aria-label={`Equity change unavailable: ${equityError}`}
                  title={equityError}
                  className="inline-flex items-center gap-1 text-sm font-semibold tabular-nums text-destructive"
                >
                  <AlertCircle className="h-3.5 w-3.5" aria-hidden />
                  n/a
                </span>
              ) : equityLoading ? (
                <Skeleton
                  variant="shimmer"
                  data-testid="range-pct-skeleton"
                  aria-label="Loading equity change"
                  role="status"
                  aria-busy="true"
                  className="h-5 w-14"
                />
              ) : equityEmpty || rangePct == null ? (
                <span
                  data-testid="range-pct-empty"
                  aria-label="No equity change data"
                  className="text-sm font-semibold tabular-nums text-muted-foreground"
                >
                  —
                </span>
              ) : currencyMismatch ? (
                <span
                  data-testid="range-pct-currency-blocked"
                  role="status"
                  aria-label={`Equity change blocked: broker currency ${brokerCcy} does not match portfolio currency ${portfolioCcy}`}
                  title={`Broker ${brokerCcy} vs portfolio ${portfolioCcy}`}
                  className="inline-flex items-center gap-1 text-sm font-semibold tabular-nums text-destructive"
                >
                  <AlertCircle className="h-3.5 w-3.5" aria-hidden />
                  blocked
                </span>
              ) : (
                <span
                  className={`text-sm font-semibold tabular-nums ${rangePct >= 0 ? "text-success" : "text-destructive"}`}
                >
                  {rangePct >= 0 ? "+" : ""}
                  {rangePct.toFixed(1)}%
                </span>
              )}
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {sparkRange}
              </span>
            </div>
            <div className="mt-2 flex gap-0.5 rounded-md border border-border/60 p-0.5">
              {SPARK_RANGES.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => setSparkRange(r.key)}
                  aria-pressed={sparkRange === r.key}
                  aria-label={`Show ${r.key} range`}
                  className={`min-h-[28px] flex-1 rounded-sm px-2 text-[11px] font-medium transition-colors ${
                    sparkRange === r.key
                      ? "bg-primary/20 text-primary"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {r.key}
                </button>
              ))}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="flex items-center justify-end gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              Total equity
              {isRefreshingEquity && !equityLoading ? (
                <span
                  data-testid="equity-refreshing-dot"
                  aria-label="Refreshing equity"
                  title="Refreshing"
                  className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary/70"
                />
              ) : null}
            </div>
            {equityError ? (
              <div
                role="alert"
                aria-live="polite"
                aria-label={`Total equity unavailable: ${equityError}`}
                data-testid="total-equity-error"
                className="flex flex-col items-end gap-1"
              >
                <div className="flex items-center gap-1 text-2xl font-bold leading-tight tabular-nums text-destructive">
                  <AlertCircle className="h-5 w-5" aria-hidden />
                  {portfolio.currency} n/a
                </div>
                <div
                  data-testid="total-equity-error-message"
                  className="mt-1 max-w-[14rem] truncate text-xs tabular-nums text-destructive/80"
                  title={equityError}
                >
                  {equityError}
                </div>
                {onRetryEquity ? (
                  <button
                    type="button"
                    data-testid="total-equity-retry"
                    onClick={onRetryEquity}
                    className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                  >
                    <RefreshCw className="h-3 w-3" aria-hidden /> Retry
                  </button>
                ) : null}
              </div>
            ) : equityLoading ? (
              <div
                role="status"
                aria-busy="true"
                aria-label="Loading total equity"
                data-testid="total-equity-loading"
                className="flex flex-col items-end gap-1"
              >
                <Skeleton
                  variant="shimmer"
                  data-testid="total-equity-skeleton"
                  className="mt-1 h-8 w-40"
                />
                <Skeleton variant="shimmer" className="h-4 w-24" />
                <Skeleton variant="shimmer" className="h-4 w-16" />
              </div>
            ) : equityEmpty ? (
              <>
                <div
                  data-testid="total-equity-empty"
                  aria-label="Total equity unavailable"
                  className="font-display text-2xl font-bold leading-tight tabular-nums text-muted-foreground"
                >
                  {portfolio.currency} —
                </div>
                <div className="mt-1 text-xs tabular-nums text-muted-foreground">
                  No equity snapshots yet
                </div>
              </>
            ) : (
              <>
                <div className="font-display text-2xl font-bold leading-tight tabular-nums">
                  {portfolio.currency} {formatMoneyAmount(totalEquity, equityDecimals)}
                </div>
                <div className="mt-1 text-xs tabular-nums text-muted-foreground">
                  {formatMoney(Number(portfolio.current_cash), portfolio.currency, equityDecimals)}
                  <span className="ml-1 text-[10px]">cash</span>
                </div>
                {currencyMismatch ? (
                  <div
                    data-testid="pnl-currency-blocked"
                    className="text-xs tabular-nums text-destructive"
                    title={`Broker ${brokerCcy} vs portfolio ${portfolioCcy}`}
                  >
                    P&amp;L blocked
                    <span className="ml-1 text-[10px] text-muted-foreground">currency mismatch</span>
                  </div>
                ) : (
                  <div className={`text-xs tabular-nums ${pnl >= 0 ? "text-success" : "text-destructive"}`}>
                    {pnl >= 0 ? "+" : ""}
                    {pnlPct.toFixed(2)}%
                    <span className="ml-1 text-[10px] text-muted-foreground">cash vs start</span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <HoldingsStrip
          holdings={holdings}
          currency={portfolio.currency}
          cash={Number(portfolio.current_cash)}
          totalEquity={totalEquity}
          portfolioId={portfolio.id}
        />
      </CardContent>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete portfolio?"
        description={
          <>
            <p>
              You're about to permanently delete{" "}
              <span className="font-semibold text-foreground">{portfolio.name}</span>, including all trades,
              decisions and history.
            </p>
            <p>This cannot be undone.</p>
          </>
        }
        requireText="DELETE"
        confirmLabel="Delete portfolio"
        onConfirm={() => {
          setConfirmDelete(false);
          deleteMut.mutate(portfolio.id);
        }}
      />
      <RenamePortfolioDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        portfolioId={portfolio.id}
        currentName={portfolio.name}
      />
      {isSim && (
        <AddSimFundsDialog
          open={addFundsOpen}
          onOpenChange={setAddFundsOpen}
          portfolioId={portfolio.id}
          portfolioName={portfolio.name}
          currency={portfolio.currency}
          currentCash={Number(portfolio.current_cash)}
          startingCash={Number(portfolio.starting_cash)}
        />
      )}
    </Card>
  );
}

function HoldingsStrip({
  holdings,
  currency,
  cash,
  totalEquity,
  portfolioId,
}: {
  holdings: PortfolioHoldingSummary[];
  currency: string;
  cash: number;
  totalEquity: number;
  portfolioId: string;
}) {
  type SortKey = "value" | "weight" | "symbol";
  const [sortKey, setSortKey] = useState<SortKey>("value");
  const built = holdings.map((h) => {
    const qty = Number(h.quantity);
    const avg = Number(h.avg_cost);
    const value = qty * avg;
    return { ...h, qty, avg, value };
  });
  const investedValue = built.reduce((s, r) => s + r.value, 0);
  const denom = totalEquity > 0 ? totalEquity : investedValue + cash;
  const investedPct = denom > 0 ? (investedValue / denom) * 100 : 0;
  const cashPct = denom > 0 ? (cash / denom) * 100 : 0;
  const rows = [...built].sort((a, b) => {
    if (sortKey === "symbol") return a.symbol.localeCompare(b.symbol);
    // value and weight rank identically (weight = value / denom)
    return b.value - a.value;
  });

  if (rows.length === 0) {
    return (
      <div className="mt-4 flex items-center gap-2 rounded-lg border border-dashed border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        <Wallet className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>Fully in cash — no open positions.</span>
      </div>
    );
  }

  const TOP = 6;
  const top = rows.slice(0, TOP);
  const rest = rows.length - top.length;
  const fmtVal = (n: number) =>
    n >= 1000
      ? `${currency} ${(n / 1000).toFixed(1)}k`
      : `${currency} ${n.toFixed(0)}`;

  return (
    <div
      className="mt-4 rounded-lg border border-border/70 bg-muted/30 p-2.5 sm:p-3"
      data-testid="portfolio-row-holdings-strip"
      data-portfolio-id={portfolioId}
    >
      <div className="mb-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <Briefcase className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">Holdings</span>
          <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
            {rows.length}
          </span>
        </div>
        <div
          role="group"
          aria-label="Sort holdings"
          className="inline-flex shrink-0 overflow-hidden rounded-md border border-border/60 bg-background text-[11px]"
          data-testid="holdings-sort"
        >
          {(["value", "weight", "symbol"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setSortKey(k)}
              aria-pressed={sortKey === k}
              data-testid={`holdings-sort-${k}`}
              className={`min-h-[32px] min-w-[36px] px-2 py-1 uppercase tracking-wide transition-colors ${
                sortKey === k
                  ? "bg-primary/15 font-semibold text-primary"
                  : "text-muted-foreground hover:text-foreground active:bg-muted"
              }`}
            >
              {k === "value" ? "Val" : k === "weight" ? "%" : "A–Z"}
            </button>
          ))}
        </div>
      </div>

      <div
        className="mb-2 grid grid-cols-2 gap-2 text-[11px]"
        data-testid="allocation-summary"
      >
        <div className="rounded-md border border-primary/30 bg-primary/10 px-2 py-1.5">
          <div className="flex items-center justify-between gap-2 text-primary">
            <span className="inline-flex min-w-0 items-center gap-1 font-semibold uppercase tracking-wide">
              <span className="h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden />
              <span className="truncate">Invested</span>
            </span>
            <span className="shrink-0 font-semibold tabular-nums">{investedPct.toFixed(1)}%</span>
          </div>
          <div className="mt-0.5 truncate font-display text-sm tabular-nums text-foreground">
            {formatMoney(investedValue, currency, 0)}
          </div>
        </div>
        <div className="rounded-md border border-border/70 bg-background px-2 py-1.5">
          <div className="flex items-center justify-between gap-2 text-muted-foreground">
            <span className="inline-flex min-w-0 items-center gap-1 font-semibold uppercase tracking-wide">
              <span className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/60" aria-hidden />
              <span className="truncate">Cash</span>
            </span>
            <span className="shrink-0 font-semibold tabular-nums">{cashPct.toFixed(1)}%</span>
          </div>
          <div className="mt-0.5 truncate font-display text-sm tabular-nums text-foreground">
            {formatMoney(cash, currency, 0)}
          </div>
        </div>
      </div>

      <div
        className="mb-1 flex h-2 w-full overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`${investedPct.toFixed(0)} percent invested (${formatMoney(investedValue, currency, 0)}), ${cashPct.toFixed(0)} percent cash (${formatMoney(cash, currency, 0)})`}
      >
        <div
          className="h-full bg-primary/80"
          style={{ width: `${Math.min(100, Math.max(0, investedPct))}%` }}
        />
        <div
          className="h-full bg-muted-foreground/40"
          style={{ width: `${Math.min(100, Math.max(0, cashPct))}%` }}
        />
      </div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        <span className="truncate">Total {formatMoney(investedValue + cash, currency, 0)}</span>
        <span className="shrink-0 tabular-nums">
          {rows.length} position{rows.length === 1 ? "" : "s"}
        </span>
      </div>

      <ul className="-mx-0.5 flex flex-wrap gap-1.5">
        {top.map((r) => {
          const w = denom > 0 ? (r.value / denom) * 100 : 0;
          return (
            <li
              key={r.symbol}
              className="inline-flex min-h-[32px] max-w-full items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] tabular-nums active:bg-muted"
              title={`${r.symbol} — ${r.qty.toLocaleString(undefined, {
                maximumFractionDigits: 4,
              })} @ ${currency} ${r.avg.toFixed(2)} · ${w.toFixed(1)}% of portfolio`}
            >
              <span className="truncate font-semibold tracking-tight">{r.symbol}</span>
              <span className="truncate text-muted-foreground">{fmtVal(r.value)}</span>
              <span className="shrink-0 rounded-sm bg-primary/10 px-1 text-[10px] font-medium text-primary">
                {w.toFixed(1)}%
              </span>
            </li>
          );
        })}
        {rest > 0 && (
          <li className="inline-flex min-h-[32px] items-center gap-1 rounded-md border border-dashed border-border/60 px-2 py-1 text-[11px] text-muted-foreground">
            +{rest} more
          </li>
        )}
      </ul>
    </div>
  );
}

