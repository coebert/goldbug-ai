// Shows how a portfolio's `current_cash` scalar maps into the per-currency
// `cash_by_ccy` wallet, and — using the same trimmer the executor runs before
// placing orders — how each pending buy is allowed, funded via an FX leg, or
// skipped. Read-only preview.

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Wallet,
  ArrowRight,
  AlertTriangle,
  Info,
  Settings2,
  BellRing,
} from "lucide-react";
import { toast } from "sonner";

import { getWalletAffordability } from "@/lib/wallet-affordability.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface Props {
  portfolioId: string;
  active?: boolean;
}

const fmt = (n: number, ccy: string, dp = 2) =>
  n.toLocaleString("en-GB", {
    style: "currency",
    currency: ccy,
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
const fmtN = (n: number, dp = 2) =>
  n.toLocaleString("en-GB", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });

type DriftSettings = {
  enabled: boolean;
  /** Absolute drift threshold in base currency. */
  absBase: number;
  /** Relative drift threshold as a fraction of current_cash (0.01 = 1%). */
  pct: number;
  /** Suppress toast when the same signed bucket has already been alerted. */
  notify: boolean;
};

const DEFAULT_DRIFT: DriftSettings = {
  enabled: true,
  absBase: 25,
  pct: 0.01,
  notify: true,
};

const driftKey = (portfolioId: string) => `wallet-drift-alert:${portfolioId}`;

function loadDriftSettings(portfolioId: string): DriftSettings {
  if (typeof window === "undefined") return DEFAULT_DRIFT;
  try {
    const raw = window.localStorage.getItem(driftKey(portfolioId));
    if (!raw) return DEFAULT_DRIFT;
    const parsed = JSON.parse(raw) as Partial<DriftSettings>;
    return {
      enabled: parsed.enabled ?? DEFAULT_DRIFT.enabled,
      absBase: Number.isFinite(parsed.absBase) ? Number(parsed.absBase) : DEFAULT_DRIFT.absBase,
      pct: Number.isFinite(parsed.pct) ? Number(parsed.pct) : DEFAULT_DRIFT.pct,
      notify: parsed.notify ?? DEFAULT_DRIFT.notify,
    };
  } catch {
    return DEFAULT_DRIFT;
  }
}


export function WalletAffordabilityCard({ portfolioId, active = true }: Props) {
  const fetchFn = useServerFn(getWalletAffordability);
  const q = useQuery({
    queryKey: ["wallet-affordability", portfolioId],
    queryFn: () => fetchFn({ data: { portfolioId } }),
    enabled: active,
    refetchInterval: active ? 30_000 : false,
    staleTime: 20_000,
  });

  if (q.isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Wallet className="h-4 w-4" /> Wallet & affordability
          </CardTitle>
        </CardHeader>
        <CardContent className="h-40 animate-pulse rounded bg-muted/30" />
      </Card>
    );
  }
  if (q.isError || !q.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Wallet className="h-4 w-4" /> Wallet & affordability
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Unable to load wallet preview.
        </CardContent>
      </Card>
    );
  }

  const d = q.data;
  const walletEntries = Object.entries(d.wallet)
    .map(([ccy, bal]) => ({ ccy, bal: Number(bal) }))
    .sort((a, b) => (a.ccy === d.baseCcy ? -1 : b.ccy === d.baseCcy ? 1 : a.ccy.localeCompare(b.ccy)));

  const baseSum = walletEntries.reduce((acc, w) => {
    if (w.ccy === d.baseCcy) return acc + w.bal;
    const inv = d.fxRates[w.ccy]?.rate;
    return acc + (inv && inv > 0 ? w.bal / inv : 0);
  }, 0);
  const scalarDelta = baseSum - d.currentCash;

  const noWallet = !d.rawCashByCcy || Object.keys(d.rawCashByCcy).length === 0;

  return (
    <TooltipProvider delayDuration={150}>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between gap-2 text-base">
            <span className="flex items-center gap-2">
              <Wallet className="h-4 w-4" /> Wallet & affordability
            </span>
            <span className="flex items-center gap-2 text-xs font-normal text-muted-foreground">
              Base {d.baseCcy}
              {d.fxEnabled ? (
                <Badge variant="secondary" className="text-[10px]">FX {d.fxExecutionMode ?? "wallet"}</Badge>
              ) : (
                <Badge variant="outline" className="text-[10px]">FX off</Badge>
              )}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Scalar vs wallet mapping */}
          <div className="rounded-md border p-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs uppercase text-muted-foreground">current_cash</div>
                <div className="text-base font-semibold tabular-nums">
                  {fmt(d.currentCash, d.baseCcy)}
                </div>
              </div>
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
              <div className="text-right">
                <div className="text-xs uppercase text-muted-foreground flex items-center gap-1 justify-end">
                  cash_by_ccy (≈ base)
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-3 w-3" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      Per-currency balances converted back to {d.baseCcy} at the current FX rate.
                      Should equal current_cash when only base currency is held.
                    </TooltipContent>
                  </Tooltip>
                </div>
                <div className="text-base font-semibold tabular-nums">
                  {fmt(baseSum, d.baseCcy)}
                </div>
              </div>
            </div>
            {noWallet && (
              <div className="mt-2 text-xs text-muted-foreground">
                No <code>cash_by_ccy</code> stored yet — showing synthesized {d.baseCcy}-only wallet from the scalar balance.
              </div>
            )}
            {!noWallet && Math.abs(scalarDelta) > 0.5 && (
              <div className="mt-2 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                Wallet {scalarDelta >= 0 ? "exceeds" : "trails"} scalar by{" "}
                {fmt(Math.abs(scalarDelta), d.baseCcy)} — likely stale FX or an unmirrored write.
              </div>
            )}
          </div>

          {/* Per-currency balances */}
          <div>
            <div className="mb-2 text-xs uppercase text-muted-foreground">Balances by currency</div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="py-1 pr-3">Ccy</th>
                    <th className="py-1 pr-3 text-right">Balance</th>
                    <th className="py-1 pr-3 text-right">FX → {d.baseCcy}</th>
                    <th className="py-1 pr-3 text-right">Requested (buys)</th>
                    <th className="py-1 pr-3 text-right">Allowed</th>
                    <th className="py-1 pr-3 text-right">Shortfall</th>
                  </tr>
                </thead>
                <tbody>
                  {walletEntries.map((w) => {
                    const row = d.perCcy.find((c) => c.ccy === w.ccy) ?? {
                      ccy: w.ccy,
                      balance: w.bal,
                      requested: 0,
                      allowed: 0,
                      shortfall: 0,
                    };
                    const rate =
                      w.ccy === d.baseCcy ? 1 : d.fxRates[w.ccy]?.rate;
                    const stale = d.fxRates[w.ccy]?.stale;
                    const src = d.fxRates[w.ccy]?.source;
                    return (
                      <tr key={w.ccy} className="border-t">
                        <td className="py-1.5 pr-3 font-medium">
                          {w.ccy}
                          {w.ccy === d.baseCcy && (
                            <Badge variant="outline" className="ml-1 text-[10px]">base</Badge>
                          )}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">
                          {fmtN(w.bal)}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums text-xs">
                          {rate ? (
                            <span className={stale ? "text-amber-600 dark:text-amber-400" : ""}>
                              {rate === 1 ? "—" : (1 / rate).toFixed(4)}
                              {src && rate !== 1 && (
                                <span className="ml-1 text-[10px] text-muted-foreground">({src})</span>
                              )}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">n/a</span>
                          )}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">
                          {row.requested ? fmtN(row.requested) : "—"}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">
                          {row.requested ? fmtN(row.allowed) : "—"}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">
                          {row.shortfall > 0 ? (
                            <span className="text-destructive">{fmtN(row.shortfall)}</span>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Per-order trimmer decisions */}
          <div>
            <div className="mb-2 flex items-center justify-between text-xs uppercase text-muted-foreground">
              <span>Pending buys — trim preview</span>
              <span className="normal-case">
                {d.trim.decisions.length} order{d.trim.decisions.length === 1 ? "" : "s"} ·{" "}
                {d.trim.skippedCount} skipped · {d.trim.fxLegs.length} FX leg
                {d.trim.fxLegs.length === 1 ? "" : "s"}
              </span>
            </div>

            {d.trim.decisions.length === 0 ? (
              <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                No pending buy slices. When the executor queues new buys they'll appear here with their affordability outcome.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="py-1 pr-3">Symbol</th>
                      <th className="py-1 pr-3 text-right">Qty</th>
                      <th className="py-1 pr-3 text-right">Price</th>
                      <th className="py-1 pr-3 text-right">Notional</th>
                      <th className="py-1 pr-3">Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.trim.decisions.map((dec, i) => {
                      const o = dec.order;
                      const allowed = dec.kind === "allow";
                      return (
                        <tr key={`${o.symbol}-${i}`} className="border-t align-top">
                          <td className="py-1.5 pr-3 font-medium">
                            {o.symbol}
                            <span className="ml-1 text-[10px] text-muted-foreground">
                              {o.instrument_ccy}
                            </span>
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{fmtN(o.quantity, 4)}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">
                            {o.price > 0 ? fmtN(o.price, 4) : <span className="text-muted-foreground">n/a</span>}
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">
                            {fmtN(dec.notionalNative)} {o.instrument_ccy}
                          </td>
                          <td className="py-1.5 pr-3">
                            {allowed ? (
                              <div className="space-y-1">
                                <Badge className="bg-emerald-600 hover:bg-emerald-600">Allow</Badge>
                                {dec.fxLeg && (
                                  <div className="text-xs text-muted-foreground">
                                    FX leg: {fmtN(dec.fxLeg.amountFrom)} {dec.fxLeg.fromCcy} →{" "}
                                    {fmtN(dec.fxLeg.amountTo)} {dec.fxLeg.toCcy} @{" "}
                                    {dec.fxLeg.rate.toFixed(4)}
                                    {dec.fxLeg.stale && (
                                      <span className="ml-1 text-amber-600 dark:text-amber-400">
                                        (stale)
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <div className="space-y-1">
                                <Badge variant="destructive">Skip</Badge>
                                <div className="text-xs text-muted-foreground">{dec.reason}</div>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* FX-rate sensitivity */}
          {d.sensitivity && d.sensitivity.length > 0 && (
            <div>
              <div className="mb-2 flex items-center gap-1 text-xs uppercase text-muted-foreground">
                <span>FX-rate sensitivity</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-3 w-3" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    Re-runs the same trimmer with each pair's rate shocked by ±2/5/10%
                    (holding other pairs fixed). Shows how affordability and skip
                    counts move if the currency weakens (+) or strengthens (−) vs {d.baseCcy}.
                  </TooltipContent>
                </Tooltip>
              </div>
              <div className="space-y-4">
                {d.sensitivity.map((s) => (
                  <div key={s.ccy} className="rounded-md border p-3">
                    <div className="mb-2 flex items-center justify-between text-sm">
                      <div className="font-medium">
                        {d.baseCcy}/{s.ccy}
                        <span className="ml-2 text-xs text-muted-foreground">
                          spot {s.baseRate ? s.baseRate.toFixed(4) : "n/a"}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground tabular-nums">
                        baseline allowed{" "}
                        {fmt(s.baselineAllowedBase, d.baseCcy)}
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-left text-muted-foreground">
                            <th className="py-1 pr-3">Shock</th>
                            <th className="py-1 pr-3 text-right">Shocked rate</th>
                            <th className="py-1 pr-3 text-right">Allowed ({s.ccy})</th>
                            <th className="py-1 pr-3 text-right">Allowed (≈ {d.baseCcy})</th>
                            <th className="py-1 pr-3 text-right">Δ vs base</th>
                            <th className="py-1 pr-3 text-right">Skipped</th>
                          </tr>
                        </thead>
                        <tbody>
                          {s.scenarios.map((sc) => {
                            const up = sc.deltaAllowedBase > 0.005;
                            const down = sc.deltaAllowedBase < -0.005;
                            return (
                              <tr key={sc.shockPct} className="border-t">
                                <td className="py-1 pr-3 font-medium tabular-nums">
                                  {sc.shockPct > 0 ? "+" : ""}
                                  {(sc.shockPct * 100).toFixed(0)}%
                                </td>
                                <td className="py-1 pr-3 text-right tabular-nums">
                                  {sc.shockedRate ? sc.shockedRate.toFixed(4) : "—"}
                                </td>
                                <td className="py-1 pr-3 text-right tabular-nums">
                                  {fmtN(sc.allowedNative)}
                                </td>
                                <td className="py-1 pr-3 text-right tabular-nums">
                                  {fmt(sc.allowedBase, d.baseCcy)}
                                </td>
                                <td
                                  className={`py-1 pr-3 text-right tabular-nums ${
                                    up
                                      ? "text-emerald-600 dark:text-emerald-400"
                                      : down
                                        ? "text-destructive"
                                        : "text-muted-foreground"
                                  }`}
                                >
                                  {sc.deltaAllowedBase >= 0 ? "+" : ""}
                                  {fmt(sc.deltaAllowedBase, d.baseCcy)}
                                </td>
                                <td className="py-1 pr-3 text-right tabular-nums">
                                  {sc.skippedCount}
                                  {sc.deltaSkipped !== 0 && (
                                    <span
                                      className={`ml-1 text-[10px] ${
                                        sc.deltaSkipped > 0
                                          ? "text-destructive"
                                          : "text-emerald-600 dark:text-emerald-400"
                                      }`}
                                    >
                                      ({sc.deltaSkipped > 0 ? "+" : ""}
                                      {sc.deltaSkipped})
                                    </span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="text-[11px] text-muted-foreground">
            Preview runs the same <code>trimBuysToBudgetByCurrency</code> logic as the executor, with a 1% safety buffer per currency.
            Missing prices are backfilled from the daily price cache.
          </p>

        </CardContent>
      </Card>
    </TooltipProvider>
  );
}
